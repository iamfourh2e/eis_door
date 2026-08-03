import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DoorWatch Local",
  description: "Local ZKBio CVSecurity door access monitoring and event collection.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
