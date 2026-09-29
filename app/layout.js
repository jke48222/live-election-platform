import { Merriweather, Source_Sans_3 } from "next/font/google";
import "./globals.css";

/* next/font downloads these at build time and serves them from this app's own
   origin, so no page load reaches Google and nothing blocks first render. */
const display = Merriweather({
  subsets: ["latin"],
  weight: ["700", "900"],
  display: "swap",
  variable: "--font-display",
});
const body = Source_Sans_3({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-body",
});

export const metadata = {
  title: "Live Election Platform",
  description: "Real-time, presenter-paced elections for any organization.",
};

/* No maximumScale: voters must be able to pinch-zoom the ballot. Inputs use a
   16px or larger font so iOS does not zoom on focus. */
export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#2563eb",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
