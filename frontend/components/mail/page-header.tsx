'use client'

import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'

interface PageHeaderProps {
  title: React.ReactNode
  fallbackHref: string
  actions?: React.ReactNode
}

export const headerIconButton =
  'relative flex size-9 shrink-0 items-center justify-center rounded-lg text-subtle-foreground transition-colors duration-150 outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50 data-popup-open:bg-muted data-popup-open:text-foreground'

export function PageHeader({ title, fallbackHref, actions }: PageHeaderProps) {
  const router = useRouter()

  function goBack() {
    if (window.history.length > 1) router.back()
    else router.push(fallbackHref)
  }

  return (
    <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-border bg-background/95 px-3 py-3 backdrop-blur md:px-5">
      <button type="button" onClick={goBack} className={headerIconButton} aria-label="Go back">
        <ArrowLeft className="size-[18px] text-foreground" />
      </button>
      <h1 className="min-w-0 flex-1 truncate text-base font-medium text-foreground md:text-lg">{title}</h1>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
  )
}
