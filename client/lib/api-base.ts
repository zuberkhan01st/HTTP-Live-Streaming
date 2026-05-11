export function getApiBase(): string {
  const base = process.env.NEXT_PUBLIC_API_BASE?.replace(/\/$/, "");
  if (base) return base;
  return "http://127.0.0.1:3001";
}
