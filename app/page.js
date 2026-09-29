'use client';

import { useEffect, useRef, useState } from 'react';

export default function Home() {
  const inputRef = useRef(null);

  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!file) {
      setPreviewUrl('');
      return;
    }

    const url = URL.createObjectURL(file);
    setPreviewUrl(url);

    return () => URL.revokeObjectURL(url);
  }, [file]);

  function selectFile(selectedFile) {
    if (!selectedFile) return;

    if (!selectedFile.type.startsWith('image/')) {
      setMessage('이미지 파일만 선택할 수 있습니다.');
      return;
    }

    setFile(selectedFile);
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

    const droppedFile = event.dataTransfer.files?.[0];
    selectFile(droppedFile);
  }

  function handleAnalyze() {
    if (!file) {
      setMessage('분석할 공지사항 이미지를 먼저 선택해주세요.');
      return;
    }

    setMessage('다음 단계에서 Supabase와 Gemini AI 분석 기능을 연결합니다.');
  }

  function removeFile() {
    setFile(null);
    setMessage('');

    if (inputRef.current) {
      inputRef.current.value = '';
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

          <div className="header-badge">
            AI Notice Assistant
          </div>
        </div>
      </header>

      <main className="main">
        <section className="hero">
          <div className="hero-badge">
            ✨ Gemini 기반 공지 분석
          </div>

          <h1>
            복잡한 공지사항을
            <br />
            <span>한눈에 이해하세요.</span>
          </h1>

          <p>
            학교 공지, 행사 포스터, 안내문 이미지를 올리면
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
            {!previewUrl ? (
              <>
                <div className="upload-icon">📄</div>

                <h3>공지사항 이미지를 올려주세요</h3>

                <p>
                  이미지를 이곳에 드래그하거나
                  <br />
                  아래 버튼으로 파일을 선택할 수 있습니다.
                </p>

                <input
                  ref={inputRef}
                  className="file-input"
                  type="file"
                  accept="image/*"
                  onChange={handleFileChange}
                />
              </>
            ) : (
              <>
                <img
                  className="preview"
                  src={previewUrl}
                  alt="선택한 공지사항 미리보기"
                />

                <p style={{ marginTop: '14px' }}>
                  {file?.name}
                </p>

                <button
                  type="button"
                  onClick={removeFile}
                  style={{
                    marginTop: '12px',
                    border: '0',
                    background: 'transparent',
                    color: '#777e90',
                    fontWeight: '700',
                  }}
                >
                  다른 이미지 선택
                </button>
              </>
            )}
          </div>

          <button
            className="primary-button"
            type="button"
            onClick={handleAnalyze}
            disabled={!file}
          >
            ✨ 공지 분석하기
          </button>

          {message && (
            <div className="message">
              {message}
            </div>
          )}
        </section>

        <section className="history-section">
          <div className="section-heading">
            <div>
              <h2>최근 공지</h2>
              <p>
                분석한 공지사항이 여기에 자동으로 저장됩니다.
              </p>
            </div>
          </div>

          <div className="empty-state">
            <strong>아직 분석한 공지가 없습니다.</strong>
            첫 번째 공지사항 이미지를 올려보세요.
          </div>
        </section>
      </main>

      <footer className="footer">
        Notice AI · 공지사항을 더 빠르고 간단하게
      </footer>
    </div>
  );
}
