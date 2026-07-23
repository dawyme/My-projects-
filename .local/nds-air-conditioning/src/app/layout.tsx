import type { Metadata } from "next";
import { Navbar } from "./components/Navbar";
import { CartProvider } from "@/context/CartContext";
import { WishlistProvider } from "@/context/WishlistContext";
import "./globals.css";

export const metadata: Metadata = {
  title: "N&D's Air Conditioning and Refrigeration Services",
  description: "Expert HVAC, refrigeration, auto AC, and washing machine/dryer repair and installation services.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="relative">
        <CartProvider>
          <WishlistProvider>
            <Navbar />
            <main className="pt-16 min-h-[calc(100vh-64px)]">{children}</main>
          </WishlistProvider>
        </CartProvider>
      </body>
    </html>
  );
}