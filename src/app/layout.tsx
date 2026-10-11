import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "PrintMap — Vos lieux, en volume",
  description:
    "Créez une maquette imprimable de votre ville : bâtiments, routes, jardins et eau, avec nettoyage à l’échelle de l’impression.",
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
