import type { NextConfig } from "next";

// Sem nada: o front nao faz proxy para a API. Ele fala com ela direto, pelo
// `NEXT_PUBLIC_API_URL`, para que o stream SSE apareca cru no devtools -- um
// proxy no meio esconderia justamente o que este projeto existe para mostrar.
// Quem libera a origem e o CORS do FastAPI (apps/api/main.py).
const nextConfig: NextConfig = {};

export default nextConfig;
