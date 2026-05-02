export default function Home() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem",
      }}
    >
      <h1 style={{ fontSize: "2.5rem", margin: 0, letterSpacing: "-0.02em" }}>
        Das Operator
      </h1>
      <p style={{ opacity: 0.6, marginTop: "0.5rem" }}>
        ERP skeleton — Phase 1.0
      </p>
      <div
        style={{
          marginTop: "3rem",
          fontSize: "0.85rem",
          opacity: 0.4,
          fontFamily: "ui-monospace, monospace",
        }}
      >
        Cloudflare Pages • D1 • R2 • Workers
      </div>
    </main>
  );
}
