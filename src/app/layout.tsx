import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "PrintMap — votre ville à imprimer en 3D",
  description:
    "Choisissez une zone sur la carte, obtenez une maquette de ville prête à imprimer en 3D, en une pièce ou découpée en plaques à assembler.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr">
      <body className="antialiased">{children}</body>
    </html>
  );
}
