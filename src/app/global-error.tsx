"use client";

// Replaces the root layout when an error happens above it, so it must render its
// own <html>/<body> and can't rely on globals.css — styles are inlined.
export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          background: "#0a0e14",
          color: "#e7eef6",
          fontFamily: "system-ui, sans-serif",
          textAlign: "center",
          padding: "1.5rem",
        }}
      >
        <h1 style={{ fontSize: "1.125rem", fontWeight: 600, margin: 0 }}>
          Something went wrong
        </h1>
        <p style={{ color: "#8a97a8", fontSize: "0.875rem", maxWidth: "24rem", margin: 0 }}>
          Celluloid hit an unexpected error. Please try again.
        </p>
        <button
          onClick={reset}
          style={{
            cursor: "pointer",
            borderRadius: "0.5rem",
            border: "none",
            padding: "0.5rem 1rem",
            fontSize: "0.875rem",
            fontWeight: 600,
            color: "#04121c",
            background: "linear-gradient(135deg, #2dd4ee 0%, #38bdf8 45%, #2563eb 100%)",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
