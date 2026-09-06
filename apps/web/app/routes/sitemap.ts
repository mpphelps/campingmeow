import { SITE_URL } from "~/lib/site";

export function loader() {
  const today = new Date().toISOString().slice(0, 10);

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `  <url>\n` +
    `    <loc>${SITE_URL}/</loc>\n` +
    `    <lastmod>${today}</lastmod>\n` +
    `    <changefreq>weekly</changefreq>\n` +
    `    <priority>1.0</priority>\n` +
    `  </url>\n` +
    `</urlset>\n`;

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
