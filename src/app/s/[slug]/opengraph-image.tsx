import { ImageResponse } from "next/og";
import { headers } from "next/headers";
import { getSharePayload } from "@/lib/data";
import { rateLimit } from "@/lib/rate-limit";

export const alt = "A shared Celluloid list";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function compactText(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1).trimEnd()}…`
    : normalized;
}

/** First `x-forwarded-for` hop, or "unknown" if the request arrived without one. */
function clientIp(headerList: Headers): string {
  const forwardedFor = headerList.get("x-forwarded-for");
  return forwardedFor?.split(",")[0]?.trim() || "unknown";
}

export default async function OpenGraphImage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  // IP-keyed cap: this is a public, no-auth image endpoint that link
  // unfurlers and crawlers fetch directly and repeatedly, bypassing the page
  // entirely, so it needs its own ceiling rather than inheriting the page's.
  // Unlike the page, there's no shared "unavailable" presentation to reuse
  // for an image response, so a limited caller just gets a bare 429.
  const limited = rateLimit(`share-og:${clientIp(await headers())}`, 30, 60_000);
  if (!limited.ok) {
    return new Response(null, {
      status: 429,
      headers: {
        "Cache-Control": "private, no-store",
        "Retry-After": String(Math.max(1, limited.retryAfter)),
      },
    });
  }

  const payload = await getSharePayload(slug);
  if (!payload) {
    return new Response(null, {
      status: 404,
      headers: { "Cache-Control": "private, no-store" },
    });
  }

  const listTitle = compactText(
    payload.name ?? `${payload.ownerName}'s list`,
    82,
  );
  const ownerName = compactText(payload.ownerName, 48);
  const titlePreview = payload.items
    .slice(0, 4)
    .map((item) => compactText(item.name, 32));
  const titleCount = payload.items.length;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          overflow: "hidden",
          position: "relative",
          padding: "58px 64px",
          color: "#e7eef6",
          background:
            "radial-gradient(circle at 84% 4%, rgba(45,212,238,0.18), transparent 36%), radial-gradient(circle at 8% 98%, rgba(59,130,246,0.14), transparent 38%), #0a0e14",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            opacity: 0.08,
            backgroundImage:
              "linear-gradient(to right, #e7eef6 1px, transparent 1px), linear-gradient(to bottom, #e7eef6 1px, transparent 1px)",
            backgroundSize: "64px 64px",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            height: 6,
            display: "flex",
            background: "linear-gradient(90deg, #2dd4ee, #38bdf8, #2563eb)",
          }}
        />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <div
              style={{
                width: 52,
                height: 52,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 15,
                border: "1px solid rgba(45,212,238,0.45)",
                background: "linear-gradient(145deg, #152334, #0d1724)",
                color: "#67e8f9",
                fontSize: 29,
                fontWeight: 700,
              }}
            >
              C
            </div>
            <div style={{ display: "flex", fontSize: 27, fontWeight: 650 }}>
              Celluloid
            </div>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              padding: "10px 18px",
              borderRadius: 999,
              border: "1px solid #263346",
              background: "rgba(17,24,36,0.82)",
              color: "#9aa8ba",
              fontSize: 18,
            }}
          >
            Shared from Celluloid
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", maxWidth: 980 }}>
          <div
            style={{
              display: "flex",
              marginBottom: 18,
              color: "#67e8f9",
              fontSize: 18,
              fontWeight: 700,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
            }}
          >
            Shared list
          </div>
          <div
            style={{
              display: "flex",
              color: "#f2f7fc",
              fontSize: listTitle.length > 54 ? 54 : 68,
              fontWeight: 700,
              letterSpacing: "-0.045em",
              lineHeight: 1.04,
            }}
          >
            {listTitle}
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 22,
              color: "#9aa8ba",
              fontSize: 24,
            }}
          >
            Shared by {ownerName} · {titleCount} {titleCount === 1 ? "title" : "titles"}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            minHeight: 50,
          }}
        >
          {titlePreview.length > 0 ? (
            titlePreview.map((title, index) => (
              <div
                // Index key: two titles can truncate to the same string.
                key={index}
                style={{
                  display: "flex",
                  maxWidth: 250,
                  padding: "10px 15px",
                  overflow: "hidden",
                  borderRadius: 10,
                  border: "1px solid #263346",
                  background: "rgba(17,24,36,0.86)",
                  color: "#b8c4d2",
                  fontSize: 17,
                  whiteSpace: "nowrap",
                }}
              >
                {title}
              </div>
            ))
          ) : (
            <div style={{ display: "flex", color: "#7c8795", fontSize: 18 }}>
              No titles in this list yet
            </div>
          )}
        </div>
      </div>
    ),
    {
      ...size,
      headers: { "Cache-Control": "private, no-store" },
    },
  );
}
