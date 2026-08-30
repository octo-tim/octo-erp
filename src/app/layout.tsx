import type { Metadata, Viewport } from 'next';
import './globals.css';
import { TrpcProvider } from '@/components/trpc-provider';

export const metadata: Metadata = {
  title: '옥토웍스 경영관리 시스템',
  description: '(주)옥토웍스 자체 ERP',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <TrpcProvider>{children}</TrpcProvider>
      </body>
    </html>
  );
}
