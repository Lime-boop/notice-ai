import { createClient } from '@supabase/supabase-js';

export const maxDuration = 60;

const MODEL = 'gemini-3.8-flash';

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
    tasks: Array.isArray(parsed?.tasks)
      ? parsed.tasks
          .filter((item) => typeof item === 'string' && item.trim())
          .map((item) => item.trim())
          .slice(0, 8)
      : [],
    category: allowedCategories.includes(parsed?.category)
      ? parsed.category
      : '기타',
  };
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
    const imageUrl = body?.imageUrl;

    if (!noticeId || !imageUrl) {
      return Response.json(
        { success: false, error: 'noticeId와 imageUrl이 필요합니다.' },
        { status: 400 }
      );
    }

    const imageResponse = await fetch(imageUrl, { cache: 'no-store' });

    if (!imageResponse.ok) {
      throw new Error('업로드한 이미지를 불러오지 못했습니다.');
    }

    const imageBuffer = await imageResponse.arrayBuffer();

    if (imageBuffer.byteLength > 20 * 1024 * 1024) {
      throw new Error('이미지 크기가 너무 큽니다. 20MB 이하 이미지를 사용해주세요.');
    }

    const mimeType = imageResponse.headers.get('content-type') || 'image/jpeg';
    const base64Image = Buffer.from(imageBuffer).toString('base64');

    const prompt = `당신은 공지사항 정리 도우미입니다.
이미지에 실제로 보이는 내용만 근거로 분석하세요.
보이지 않는 날짜, 장소, 마감일, 해야 할 일을 추측하거나 만들어내지 마세요.

분석 기준:
- title: 공지의 핵심 제목
- summary: 중요한 내용만 2~4문장으로 간결하게 요약
- deadline: 신청/제출 마감일. 확인할 수 없으면 빈 문자열
- event_date: 행사/교육/시험 등이 실제로 열리는 날짜. 확인할 수 없으면 빈 문자열
- location: 장소. 확인할 수 없으면 빈 문자열
- tasks: 사용자가 실제로 해야 하는 행동만 짧은 문장 배열로 정리
- category: 학교, 대회, 행사, 모집, 취업, 장학, 기타 중 하나

날짜를 확인할 수 있다면 YYYY-MM-DD 형식으로 변환하세요.
이미지가 공지사항이 아니더라도 보이는 내용을 설명하고 category는 기타로 지정하세요.`;

    const geminiResponse = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/interactions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          model: MODEL,
          input: [
            { type: 'text', text: prompt },
            {
              type: 'image',
              data: base64Image,
              mime_type: mimeType,
            },
          ],
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
                'tasks',
                'category',
              ],
            },
          },
        }),
      }
    );

    const geminiData = await geminiResponse.json();

    if (!geminiResponse.ok) {
      const reason =
        geminiData?.error?.message ||
        geminiData?.message ||
        'Gemini 분석 요청에 실패했습니다.';
      throw new Error(reason);
    }

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
          tasks: result.tasks,
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
