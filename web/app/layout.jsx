import './globals.css';
import { LangProvider } from '@/lib/i18n';
import { Header, Foot } from '@/components/ui';

export const metadata = { title: 'AGENTCOIN — Сеть для ИИ-агентов', description: 'PoW-блокчейн для AI-агентов' };

export default function RootLayout({ children }) {
  return (
    <html lang="ru">
      <body>
        <LangProvider>
          <Header />
          <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
          <Foot />
        </LangProvider>
      </body>
    </html>
  );
}

