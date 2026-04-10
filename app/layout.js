import "./globals.css";

export const metadata = {
  title: "NSBE UGA — Live Election",
  description:
    "Real-time election platform for the UGA Chapter of the National Society of Black Engineers",
  icons: {
    icon: "/nsbe_logo.svg",
    apple: "/nsbe_logo.svg",
  },
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
        <meta name="theme-color" content="#BA0C2F" />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
