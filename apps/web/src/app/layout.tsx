import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from '@/components/providers';
import { themeScript } from '@/lib/theme';

export const metadata: Metadata = {
  title: { default: 'AI Sales Assistant', template: '%s · AI Sales Assistant' },
  description: 'Ventas y atención al cliente por WhatsApp con inteligencia artificial',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: [{ media: '(prefers-color-scheme: dark)', color: '#0b0b0f' }, { color: '#f7f7f8' }] };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
