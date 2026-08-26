import type { Metadata, Viewport } from "next";
import { Providers } from "@/components/providers";
import { env } from "@/lib/env";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: `${env.businessName} · Collection`,
    template: `%s · ${env.businessName}`,
  },
  description: "Client billing, payment collection and cash reconciliation for a water supply business.",
  applicationName: env.businessName,
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Deliberately not locked to 1 - users must be able to zoom the figures.
  maximumScale: 5,
  themeColor: "#0b4f8a",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
