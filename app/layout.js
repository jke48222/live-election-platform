import "./globals.css";

export const metadata = {
  title: "Live Election Platform",
  description: "Real-time, presenter-paced elections for any organization.",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <meta name="theme-color" content="#2563eb" />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
