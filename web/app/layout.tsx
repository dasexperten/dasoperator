export const metadata = {
  title: "Das Operator ERP",
  description: "Das Experten internal operations system",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          background: "#0a0a0a",
          color: "#fafafa",
        }}
      >
        {children}
      </body>
    </html>
  );
}
