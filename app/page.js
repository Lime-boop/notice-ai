'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

const MAX_FILE_SIZE = 30 * 1024 * 1024;
const ALLOWED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'pdf', 'hwpx', 'docx', 'txt', 'csv'];

export default function Home() {
  const inputRef = useRef(null);

  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [notices, setNotices] = useState([]);
  const [loadingNotices, setLoadingNotices] = useState(true);

  const loadNotices = useCallback(async () => {
    setLoadingNotices(true);

    const { data, error } = await supabase
      .from('notices')
      .select(`
        id,
        created_at,
        image_url,
        status,
        notice_summaries (
          title,
          summary,
          deadline,
          event_date,
          location,
          tasks,
          category
        )
      `)
      .order('created_at', { ascending: false });

    if (error) {
      console.error(error);
      setMessage('기록을 불러오는 중 문제가 발생했습니다.');
    } else {
      setNotices(data || []);
    }

    setLoadingNotices(false);
  }, []);

  useEffect(() => {
    loadNotices();
  }, [loadNotices]);

  useEffect(() => {
    if (!file || !file.type.startsWith('image/')) {
      setPreviewUrl('');
      return;
    }

    const url = URL.createObjectURL(file);
    setPreviewUrl(url);

    return () => URL.revokeObjectURL(url);
  }, [file]);

  function getExtension(name = '') {
    return name.split('.').pop()?.toLowerCase() || '';
  }

  function getFileIcon(selectedFile) {
    const ext = getExtension(selectedFile?.name);

    if (ext === 'pdf') return '📕';
    if (ext === 'hwpx') return '📘';
    if (ext === 'docx') return '📄';
    if (['txt', 'csv'].includes(ext)) return '📝';
    return '🖼️';
  }

  function selectFile(selectedFile) {
    if (!selectedFile) return;

    const extension = getExtension(selectedFile.name);

    if (!ALLOWED_EXTENSIONS.includes(extension)) {
      setMessage('이미지, PDF, HWPX, DOCX, TXT, CSV 파일만 업로드할 수 있습니다.');
      return;
    }

    if (selectedFile.size > MAX_FILE_SIZE) {
      setMessage('30MB 이하 파일만 업로드할 수 있습니다.');
      return;
    }

    setFile(selectedFile);
    setResult(null);
    setMessage('');
  }

  function handleFileChange(event) {
    selectFile(event.target.files?.[0]);
  }

  function handleDragOver(event) {
    event.preventDefault();
    setDragging(true);
  }

  function handleDragLeave(event) {
    event.preventDefault();
    setDragging(false);
  }

  function handleDrop(event) {
    event.preventDefault();
    setDragging(false);
    selectFile(event.dataTransfer.files?.[0]);
  }

  function removeFile() {
    setFile(null);
    setResult(null);
    setMessage('');

    if (inputRef.current) {
      inputRef.current.value = '';
    }
  }

  async function handleAnalyze() {
    if (!file || busy) return;

    setBusy(true);
    setResult(null);
    setMessage('파일을 업로드하고 있습니다...');

    try {
      const fileExt = getExtension(file.name) || 'bin';
      const fileName = `${Date.now()}-${crypto.randomUUID()}.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from('notice-images')
        .upload(fileName, file, {
          cacheControl: '3600',
          upsert: false,
          contentType: file.type || undefined,
        });

      if (uploadError) {
        throw new Error('파일 업로드 실패: ' + uploadError.message);
      }

      const { data: publicUrlData } = supabase.storage
        .from('notice-images')
        .getPublicUrl(fileName);

      const fileUrl = publicUrlData.publicUrl;

      const { data: notice, error: insertError } = await supabase
        .from('notices')
        .insert({
          image_url: fileUrl,
          status: 'pending',
        })
        .select('id')
        .single();

      if (insertError) {
        throw new Error('공지 기록 저장 실패: ' + insertError.message);
      }

      await loadNotices();
      setMessage('AI가 공지 내용을 분석하고 있습니다...');

      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          noticeId: notice.id,
          fileUrl,
          fileName: file.name,
          mimeType: file.type,
        }),
      });

      const analysis = await response.json();

      if (!response.ok || !analysis.success) {
        throw new Error(analysis.error || 'AI 분석에 실패했습니다.');
      }

      setResult(analysis);
      setMessage('분석이 완료되었습니다.');
      setFile(null);

      if (inputRef.current) {
        inputRef.current.value = '';
      }

      await loadNotices();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : '처리 중 알 수 없는 오류가 발생했습니다.'
      );
    } finally {
      setBusy(false);
    }
  }

  function formatDate(value) {
    if (!value) return '확인되지 않음';

    try {
      return new Intl.DateTimeFormat('ko-KR', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }).format(new Date(`${value}T00:00:00`));
    } catch {
      return value;
    }
  }

  return (
    <div className="page">
      <header className="header">
        <div className="header-inner">
          <div className="logo">
            <div className="logo-icon">N</div>
            <span>Notice AI</span>
          </div>

          <div className="header-badge">AI Notice Assistant</div>
        </div>
      </header>

      <main className="main">
        <section className="hero">
          <div className="hero-badge">✨ Gemini 기반 공지 분석</div>

          <h1>
            복잡한 공지사항을
            <br />
            <span>한눈에 이해하세요.</span>
          </h1>

          <p>
            공지 이미지뿐 아니라 PDF·HWPX 문서도 올려보세요.
            AI가 핵심 내용과 날짜, 장소, 해야 할 일을 자동으로 정리합니다.
          </p>
        </section>

        <section className="upload-card">
          <div
            className="upload-zone"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            style={
              dragging
                ? {
                    borderColor: '#6670f5',
                    background: '#f2f3ff',
                  }
                : undefined
            }
          >
            {!file ? (
              <>
                <div className="upload-icon">📚</div>
                <h3>공지사항 파일을 올려주세요</h3>
                <p>
                  이미지 · PDF · HWPX · DOCX · TXT · CSV 지원
                  <br />
                  파일을 드래그하거나 아래에서 선택할 수 있습니다.
                </p>

                <input
                  ref={inputRef}
                  className="file-input"
                  type="file"
                  accept=".png,.jpg,.jpeg,.webp,.bmp,.pdf,.hwpx,.docx,.txt,.csv,image/*,application/pdf"
                  onChange={handleFileChange}
                />
              </>
            ) : (
              <>
                {previewUrl ? (
                  <img
                    className="preview"
                    src={previewUrl}
                    alt="선택한 공지사항 미리보기"
                  />
                ) : (
                  <div className="document-preview">
                    <div className="document-icon">{getFileIcon(file)}</div>
                    <strong>{file.name}</strong>
                    <span>{(file.size / 1024 / 1024).toFixed(2)} MB</span>
                  </div>
                )}

                {previewUrl && <p style={{ marginTop: '14px' }}>{file.name}</p>}

                <button
                  type="button"
                  onClick={removeFile}
                  disabled={busy}
                  className="change-file-button"
                >
                  다른 파일 선택
                </button>
              </>
            )}
          </div>

          <button
            className="primary-button"
            type="button"
            onClick={handleAnalyze}
            disabled={!file || busy}
          >
            {busy ? '분석 중...' : '✨ 공지 분석하기'}
          </button>

          {message && <div className="message">{message}</div>}
        </section>

        {result && (
          <section className="result-card">
            <div className="result-header">
              <h2 className="result-title">{result.title}</h2>
              <span className="category">{result.category}</span>
            </div>

            <div className="result-grid">
              <div className="info-box">
                <span className="info-label">마감일</span>
                <div className="info-value">{formatDate(result.deadline)}</div>
              </div>

              <div className="info-box">
                <span className="info-label">행사일</span>
                <div className="info-value">{formatDate(result.event_date)}</div>
              </div>

              <div className="info-box">
                <span className="info-label">장소</span>
                <div className="info-value">
                  {result.location || '확인되지 않음'}
                </div>
              </div>

              <div className="info-box">
                <span className="info-label">분류</span>
                <div className="info-value">{result.category}</div>
              </div>

              <div className="info-box summary-box">
                <span className="info-label">핵심 요약</span>
                <p className="summary-text">{result.summary}</p>
              </div>

              <div className="info-box tasks-box">
                <span className="info-label">해야 할 일</span>

                {result.tasks?.length > 0 ? (
                  <ul className="task-list">
                    {result.tasks.map((task, index) => (
                      <li className="task-item" key={`${task}-${index}`}>
                        ✓ {task}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="summary-text">확인된 해야 할 일이 없습니다.</p>
                )}
              </div>
            </div>
          </section>
        )}

        <section className="history-section">
          <div className="section-heading">
            <div>
              <h2>최근 공지</h2>
              <p>분석한 공지사항이 최신순으로 자동 저장됩니다.</p>
            </div>
          </div>

          {loadingNotices ? (
            <div className="empty-state">
              <strong>기록을 불러오는 중입니다.</strong>
              잠시만 기다려주세요.
            </div>
          ) : notices.length === 0 ? (
            <div className="empty-state">
              <strong>아직 분석한 공지가 없습니다.</strong>
              첫 번째 공지사항 파일을 올려보세요.
            </div>
          ) : (
            <div className="notice-list">
              {notices.map((notice) => {
                const summary = notice.notice_summaries?.[0];

                return (
                  <article className="notice-card" key={notice.id}>
                    <div className="notice-card-top">
                      <h3>
                        {summary?.title ||
                          (notice.status === 'error'
                            ? '분석에 실패한 공지'
                            : '분석 대기 중')}
                      </h3>

                      <span className="category">
                        {summary?.category ||
                          (notice.status === 'done'
                            ? '완료'
                            : notice.status === 'error'
                            ? '오류'
                            : '분석중')}
                      </span>
                    </div>

                    {summary ? (
                      <>
                        <p className="notice-summary">{summary.summary}</p>

                        {summary.deadline && (
                          <p className="notice-date">
                            마감 {formatDate(summary.deadline)}
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="notice-summary">
                        {notice.status === 'error'
                          ? '분석 중 문제가 발생했습니다. 다시 업로드해주세요.'
                          : 'AI 분석 결과를 기다리고 있습니다.'}
                      </p>
                    )}

                    <p className="notice-date">
                      등록 {new Date(notice.created_at).toLocaleString('ko-KR')}
                    </p>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </main>

      <footer className="footer">
        Notice AI · 공지사항을 더 빠르고 간단하게
      </footer>
    </div>
  );
}
