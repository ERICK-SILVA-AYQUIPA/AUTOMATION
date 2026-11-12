import type { NextConfig } from 'next';

/**
 * La web y la API se sirven bajo el MISMO origen: /api/v1/* se reenvía a la
 * API (apps/api). Así las cookies de sesión son de primera parte, SameSite
 * funciona sin excepciones y no hace falta CORS para el navegador.
 */
const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';

// CSP: sin plugins, sin marcos de terceros, formularios y peticiones solo al mismo
// origen (la API está detrás de /api). Next inyecta scripts en línea al hidratar, por
// eso 'unsafe-inline' en script-src; 'unsafe-eval' solo lo usa el modo desarrollo.
// Las imágenes de productos pueden venir de API_PUBLIC_URL (otro origen): img-src https.
const isDev = process.env.NODE_ENV !== 'production';
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: https: http://localhost:* http://127.0.0.1:*${isDev ? ' http:' : ''}`,
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? ' ws:' : ''}`,
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  output: 'standalone',
  async rewrites() {
    // /api/v1/internal (API para n8n) nunca se publica a través de la web
    return [{ source: '/api/v1/:path((?!internal(?:/|$)).*)', destination: `${API_INTERNAL_URL}/api/v1/:path` }];
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  turbopack: {
    rules: {
      '*.css': { loaders: ['@tailwindcss/turbopack'], as: '*.css' },
    },
  },
};

export default nextConfig;
