import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Inter, Pixelify_Sans } from 'next/font/google'
import { Toaster } from '@/components/ui/sonner'
import './globals.css'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' })
const pixel = Pixelify_Sans({ subsets: ['latin'], weight: ['600'], variable: '--font-pixel' })

export const metadata: Metadata = {
  title: {
    default: 'ONB — Email scheduling',
    template: '%s · ONB',
  },
  description:
    'Schedule, send and track outreach emails with delivery pacing, recipient lists and a distraction-free composer.',
  generator: 'v0.app',
}

export const viewport: Viewport = {
  themeColor: '#ffffff',
  colorScheme: 'light',
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${pixel.variable} bg-background`}>
      <body className="font-sans antialiased">
        {children}
        <Toaster position="bottom-right" />
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
