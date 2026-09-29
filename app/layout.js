import './globals.css';

export const metadata = {
  title: 'Notice AI',
  description: 'AI로 공지사항을 빠르게 요약하고 정리하는 서비스',
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
