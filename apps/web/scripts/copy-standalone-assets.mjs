// `output: 'standalone'` no incluye los estáticos: se copian junto al server.js
// (https://nextjs.org/docs/app/api-reference/config/next-config-js/output)
import { cpSync, existsSync } from 'node:fs';

const dest = '.next/standalone/apps/web';
cpSync('.next/static', `${dest}/.next/static`, { recursive: true });
if (existsSync('public')) cpSync('public', `${dest}/public`, { recursive: true });
console.log('Estáticos copiados a', dest);
