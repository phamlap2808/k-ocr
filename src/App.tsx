import { ScanText } from 'lucide-react';
import { OcrView } from './components/OcrView';

export default function App() {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-slate-100 font-sans text-slate-900">
      <header className="flex h-12 shrink-0 items-center gap-2 bg-brand-800 px-4 text-white">
        <ScanText size={18} aria-hidden />
        <h1 className="text-sm font-semibold">Đọc hoá đơn</h1>
      </header>
      <main className="min-h-0 flex-1">
        <OcrView />
      </main>
    </div>
  );
}
