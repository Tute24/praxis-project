import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Praxis P1 — agente de clima",
  description: "Chat que pinta a corrida do agente evento a evento, em SSE.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
