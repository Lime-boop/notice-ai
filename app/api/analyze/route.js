import { createClient } from '@supabase/supabase-js';
import JSZip from 'jszip';
import { open as openHwp, documentText as getHwpText } from 'js-hwp';

export const maxDuration = 300;

const MODEL = 'gemini-3.8-flash';
const MAX_FILE_SIZE = 30 * 1024 * 1024;
const MAX_EXTRACTED_TEXT = 180000;

function getServerSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error('Supabase 서버 환경변수가 설정되지 않았습니다.');
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestGeminiWithRetry(apiKey, body) {
  const delays = [0, 1500, 3000];
  let lastMessage = 'Gemini 분석 요청에 실패했습니다.';

  for (const delay of delays) {
    if (delay) await sleep(delay);

    let response;

    try {
      response = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/interactions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(45000),
        }
      );
    } catch (error) {
      lastMessage =
        error?.name === 'TimeoutError' || error?.name === 'AbortError'
          ? 'Gemini 응답이 45초 안에 오지 않아 요청을 다시 시도했습니다.'
          : error instanceof Error
          ? error.message
          : 'Gemini 네트워크 요청에 실패했습니다.';

      continue;
    }

    const rawBody = await response.text();
    let data = null;

    if (rawBody) {
      try {
        data = JSON.parse(rawBody);
      } catch {
        data = null;
      }
    }

    if (response.ok) {
      if (!data) {
        throw new Error(
          'Gemini가 JSON이 아닌 응답을 반환했습니다. 잠시 후 다시 시도해주세요.'
        );
      }

      return data;
    }

    lastMessage =
      data?.error?.message ||
      data?.message ||
      rawBody?.slice(0, 500) ||
      `Gemini 요청 실패 (HTTP ${response.status})`;

    if (![429, 500, 502, 503, 504].includes(response.status)) {
      throw new Error(lastMessage);
    }
  }

  throw new Error(
    'Gemini 서버가 혼잡하거나 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해주세요. ' +
      lastMessage
  );
}

function extractGeminiText(data) {
  const stepTexts = (data?.steps || [])
    .filter((step) => step?.type === 'model_output')
    .flatMap((step) => step?.content || [])
    .filter((part) => part?.type === 'text' && typeof part?.text === 'string')
    .map((part) => part.text);

  if (stepTexts.length > 0) {
    return stepTexts.join('').trim();
  }

  const legacyTexts = (data?.outputs || [])
    .filter((part) => part?.type === 'text' && typeof part?.text === 'string')
    .map((part) => part.text);

  return legacyTexts.join('').trim();
}

function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function xmlToPlainText(xml) {
  return decodeXmlEntities(
    xml
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

async function extractHwpxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);

  const sectionNames = Object.keys(zip.files)
    .filter((name) => /^Contents\/section\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const aNum = Number(a.match(/section(\d+)/i)?.[1] || 0);
      const bNum = Number(b.match(/section(\d+)/i)?.[1] || 0);
      return aNum - bNum;
    });

  if (sectionNames.length === 0) {
    throw new Error('HWPX 본문을 찾지 못했습니다.');
  }

  const parts = [];

  for (const name of sectionNames) {
    const xml = await zip.file(name)?.async('string');
    if (xml) {
      const text = xmlToPlainText(xml);
      if (text) parts.push(text);
    }
  }

  const result = parts.join('\n\n').trim();

  if (!result) {
    throw new Error('HWPX에서 읽을 수 있는 텍스트를 찾지 못했습니다.');
  }

  return result.slice(0, MAX_EXTRACTED_TEXT);
}

async function extractHwpText(buffer) {
  const bytes = new Uint8Array(buffer);
  const errors = [];

  // 1차: 실제 공공기관/학교 HWP에서 호환성이 더 좋은 Rust 기반 파서
  try {
    const { toMarkdown } = await import('@ohah/hwpjs');
    const result = toMarkdown(Buffer.from(bytes), {
      image: 'blob',
      use_html: false,
      include_version: false,
      include_page_info: false,
    });

    const markdown = result?.markdown?.trim();

    if (markdown && markdown.length >= 10) {
      return markdown.slice(0, MAX_EXTRACTED_TEXT);
    }

    errors.push('hwpjs: 추출된 본문이 비어 있음');
  } catch (error) {
    errors.push(
      'hwpjs: ' + (error instanceof Error ? error.message : String(error))
    );
  }

  // 2차: 순수 JS 파서로 자동 재시도
  try {
    const doc = openHwp(bytes);
    const text = getHwpText(doc)?.trim();

    if (text && text.length >= 10) {
      return text.slice(0, MAX_EXTRACTED_TEXT);
    }

    errors.push('js-hwp: 추출된 본문이 비어 있음');
  } catch (error) {
    errors.push(
      'js-hwp: ' + (error instanceof Error ? error.message : String(error))
    );
  }

  throw new Error(
    '이 HWP 파일의 본문을 읽지 못했습니다. 같은 파일을 PDF 또는 HWPX로 저장하면 분석할 수 있습니다. (' +
      errors.join(' / ') +
      ')'
  );
}

async function extractDocxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml')?.async('string');

  if (!xml) {
    throw new Error('DOCX 본문을 찾지 못했습니다.');
  }

  const text = xmlToPlainText(xml);

  if (!text) {
    throw new Error('DOCX에서 읽을 수 있는 텍스트를 찾지 못했습니다.');
  }

  return text.slice(0, MAX_EXTRACTED_TEXT);
}

function normalizeDate(value) {
  if (!value || typeof value !== 'string') return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function normalizeResult(parsed) {
  const allowedCategories = ['학교', '대회', '행사', '모집', '취업', '장학', '기타'];

  return {
    title:
      typeof parsed?.title === 'string' && parsed.title.trim()
        ? parsed.title.trim()
        : '제목을 확인할 수 없는 공지',
    summary:
      typeof parsed?.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : '요약 내용을 확인할 수 없습니다.',
    deadline: normalizeDate(parsed?.deadline),
    event_date: normalizeDate(parsed?.event_date),
    location:
      typeof parsed?.location === 'string' && parsed.location.trim()
        ? parsed.location.trim()
        : null,
    target_audience:
      typeof parsed?.target_audience === 'string' && parsed.target_audience.trim()
        ? parsed.target_audience.trim()
        : null,
    important_dates: Array.isArray(parsed?.important_dates)
      ? parsed.important_dates
          .filter((item) => item && typeof item === 'object')
          .map((item) => ({
            label:
              typeof item.label === 'string' && item.label.trim()
                ? item.label.trim()
                : '주요 일정',
            date: normalizeDate(item.date),
            time:
              typeof item.time === 'string' && item.time.trim()
                ? item.time.trim()
                : null,
          }))
          .filter((item) => item.date)
          .slice(0, 8)
      : [],
    tasks: Array.isArray(parsed?.tasks)
      ? parsed.tasks
          .filter((item) => typeof item === 'string' && item.trim())
          .map((item) => item.trim())
          .slice(0, 10)
      : [],
    category: allowedCategories.includes(parsed?.category)
      ? parsed.category
      : '기타',
  };
}

function getExtension(fileName = '') {
  return fileName.split('.').pop()?.toLowerCase() || '';
}

function buildPrompt(fileName) {
  return `당신은 학교/기관 공지사항 정리 도우미입니다.
첨부된 파일 "${fileName || '공지 파일'}"의 실제 내용만 근거로 분석하세요.
보이지 않거나 문서에 없는 날짜, 장소, 마감일, 해야 할 일을 추측하거나 만들어내지 마세요.

분석 기준:
- title: 공지의 핵심 제목
- summary: 중요한 내용을 3~5문장으로 요약
- deadline: 신청/제출 마감일. 확인할 수 없으면 빈 문자열
- event_date: 행사/교육/시험 등이 실제로 열리는 대표 날짜. 확인할 수 없으면 빈 문자열
- location: 장소. 확인할 수 없으면 빈 문자열
- target_audience: 참가 대상·신청 대상·적용 대상을 한 문장으로 정리. 확인할 수 없으면 빈 문자열
- important_dates: 사용자가 놓치면 안 되는 주요 일정을 최대 8개까지 배열로 정리
  - label: 일정 이름
  - date: YYYY-MM-DD
  - time: 시간이 명시된 경우에만 HH:MM 또는 문서에 적힌 시간 표현, 없으면 빈 문자열
- tasks: 사용자가 실제로 해야 하는 행동, 제출물, 준비사항을 짧은 문장 배열로 정리
- category: 학교, 대회, 행사, 모집, 취업, 장학, 기타 중 하나

날짜가 명확하면 YYYY-MM-DD 형식으로 변환하세요.
문서가 길면 세부 규정을 모두 복사하지 말고, 참가자에게 중요한 일정·대상·제출방법·준비물·유의사항을 우선 요약하세요.
중간 발표일, 접수 시작일, 심사 기간처럼 실제 행동이나 준비에 중요한 일정도 important_dates에 포함하세요.`;
}

async function buildGeminiInput({ buffer, fileName, mimeType }) {
  const extension = getExtension(fileName);
  const base64 = Buffer.from(buffer).toString('base64');
  const prompt = buildPrompt(fileName);

  if ((mimeType || '').startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(extension)) {
    return [
      { type: 'text', text: prompt },
      {
        type: 'image',
        data: base64,
        mime_type: mimeType || (extension === 'png' ? 'image/png' : 'image/jpeg'),
      },
    ];
  }

  if (mimeType === 'application/pdf' || extension === 'pdf') {
    return [
      { type: 'text', text: prompt },
      {
        type: 'document',
        data: base64,
        mime_type: 'application/pdf',
      },
    ];
  }

  if (extension === 'hwp') {
    const text = await extractHwpText(buffer);
    return [
      {
        type: 'text',
        text: `${prompt}\n\n[HWP에서 추출한 본문]\n${text}`,
      },
    ];
  }

  if (extension === 'hwpx') {
    const text = await extractHwpxText(buffer);
    return [
      {
        type: 'text',
        text: `${prompt}\n\n[HWPX에서 추출한 본문]\n${text}`,
      },
    ];
  }

  if (extension === 'docx') {
    const text = await extractDocxText(buffer);
    return [
      {
        type: 'text',
        text: `${prompt}\n\n[DOCX에서 추출한 본문]\n${text}`,
      },
    ];
  }

  if (
    (mimeType || '').startsWith('text/') ||
    ['txt', 'csv', 'json', 'xml'].includes(extension)
  ) {
    const text = Buffer.from(buffer).toString('utf8').slice(0, MAX_EXTRACTED_TEXT);
    return [
      {
        type: 'text',
        text: `${prompt}\n\n[문서 본문]\n${text}`,
      },
    ];
  }

  throw new Error('지원하지 않는 파일 형식입니다. 이미지, PDF, HWP, HWPX, DOCX, TXT, CSV를 사용해주세요.');
}

export async function POST(request) {
  let noticeId = null;

  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      throw new Error('GEMINI_API_KEY가 설정되지 않았습니다.');
    }

    const body = await request.json();
    noticeId = body?.noticeId;
    const fileUrl = body?.fileUrl || body?.imageUrl;
    const fileName = body?.fileName || 'notice-file';
    const mimeType = body?.mimeType || '';

    if (!noticeId || !fileUrl) {
      return Response.json(
        { success: false, error: 'noticeId와 fileUrl이 필요합니다.' },
        { status: 400 }
      );
    }

    const fileResponse = await fetch(fileUrl, { cache: 'no-store' });

    if (!fileResponse.ok) {
      throw new Error('업로드한 파일을 불러오지 못했습니다.');
    }

    const fileBuffer = await fileResponse.arrayBuffer();

    if (fileBuffer.byteLength > MAX_FILE_SIZE) {
      throw new Error('파일 크기가 너무 큽니다. 30MB 이하 파일을 사용해주세요.');
    }

    const resolvedMimeType =
      mimeType ||
      fileResponse.headers.get('content-type') ||
      'application/octet-stream';

    const input = await buildGeminiInput({
      buffer: fileBuffer,
      fileName,
      mimeType: resolvedMimeType,
    });

    const geminiData = await requestGeminiWithRetry(apiKey, {
      model: MODEL,
      input,
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            summary: { type: 'string' },
            deadline: { type: 'string' },
            event_date: { type: 'string' },
            location: { type: 'string' },
            target_audience: { type: 'string' },
            important_dates: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  date: { type: 'string' },
                  time: { type: 'string' },
                },
                required: ['label', 'date', 'time'],
              },
            },
            tasks: {
              type: 'array',
              items: { type: 'string' },
            },
            category: {
              type: 'string',
              enum: ['학교', '대회', '행사', '모집', '취업', '장학', '기타'],
            },
          },
          required: [
            'title',
            'summary',
            'deadline',
            'event_date',
            'location',
            'target_audience',
            'important_dates',
            'tasks',
            'category',
          ],
        },
      },
    });

    const responseText = extractGeminiText(geminiData);

    if (!responseText) {
      throw new Error('Gemini가 분석 결과를 반환하지 않았습니다.');
    }

    let parsed;

    try {
      parsed = JSON.parse(responseText);
    } catch {
      throw new Error('Gemini 분석 결과를 JSON으로 해석하지 못했습니다.');
    }

    const result = normalizeResult(parsed);
    const supabase = getServerSupabase();

    // 기존 DB 스키마를 바꾸지 않고도 참가 대상/주요 일정을 보존하기 위해
    // 화면에는 숨기는 메타 항목을 tasks(text[]) 안에 함께 저장합니다.
    const storedTasks = [
      ...(result.target_audience
        ? [`__TARGET__:${result.target_audience}`]
        : []),
      ...result.important_dates.map((item) =>
        `__DATE__:${JSON.stringify(item)}`
      ),
      ...result.tasks,
    ];

    const { error: summaryError } = await supabase
      .from('notice_summaries')
      .upsert(
        {
          notice_id: noticeId,
          title: result.title,
          summary: result.summary,
          deadline: result.deadline,
          event_date: result.event_date,
          location: result.location,
          tasks: storedTasks,
          category: result.category,
        },
        { onConflict: 'notice_id' }
      );

    if (summaryError) {
      throw new Error('분석 결과 저장 실패: ' + summaryError.message);
    }

    const { error: statusError } = await supabase
      .from('notices')
      .update({ status: 'done' })
      .eq('id', noticeId);

    if (statusError) {
      throw new Error('공지 상태 변경 실패: ' + statusError.message);
    }

    return Response.json({
      success: true,
      ...result,
    });
  } catch (error) {
    if (noticeId) {
      try {
        const supabase = getServerSupabase();
        await supabase.from('notices').update({ status: 'error' }).eq('id', noticeId);
      } catch {
        // 원래 오류 응답을 유지합니다.
      }
    }

    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : '알 수 없는 오류가 발생했습니다.',
      },
      { status: 500 }
    );
  }
}
