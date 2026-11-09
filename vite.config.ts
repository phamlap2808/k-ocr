import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxy = {
    // Keys stay server-side: the browser calls /api/gemini and the proxy adds the auth header.
    '/api/gemini': {
      target: 'https://generativelanguage.googleapis.com',
      changeOrigin: true,
      rewrite: (p: string) => p.replace(/^\/api\/gemini/, ''),
      headers: {'x-goog-api-key': env.GEMINI_API_KEY ?? ''},
    },
    // PP-OCRv5 + VietOCR (ppocr/server.py): the PP-OCR reader, and word boxes for Gemini runs (Tesseract.js when down).
    '/api/ppocr': {
      target: env.PPOCR_URL || 'http://localhost:8866',
      changeOrigin: true,
      rewrite: (p: string) => p.replace(/^\/api\/ppocr/, ''),
    },
  };
  return {
    plugins: [react(), tailwindcss()],
    server: {proxy},
    preview: {proxy},
  };
});
