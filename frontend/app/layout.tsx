import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import './globals.css';

export const metadata: Metadata = {
  title: 'BRAYN',
  description: 'AI-native customer intelligence and business action platform.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
