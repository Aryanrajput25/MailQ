'use client'

import { Filter, RotateCw, Search, X } from 'lucide-react'
import { MobileNav } from '@/components/mail/mobile-nav'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { ListFilters } from '@/lib/types'
import { cn } from '@/lib/utils'

interface MailboxToolbarProps {
  query: string
  onQueryChange: (value: string) => void
  filters: ListFilters
  onFiltersChange: (filters: ListFilters) => void
  onRefresh: () => void
  refreshing: boolean
}

const iconButton =
  'relative flex size-9 shrink-0 items-center justify-center rounded-lg text-subtle-foreground transition-colors duration-150 outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 data-popup-open:bg-muted data-popup-open:text-foreground'

export function MailboxToolbar({
  query,
  onQueryChange,
  filters,
  onFiltersChange,
  onRefresh,
  refreshing,
}: MailboxToolbarProps) {
  const activeFilters = Number(Boolean(filters.starredOnly))

  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background/95 px-3 py-3 backdrop-blur md:px-5">
      <MobileNav />
      <div className="relative min-w-0 flex-1 md:max-w-2xl">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle-foreground"
          aria-hidden="true"
        />
        <label htmlFor="mail-search" className="sr-only">
          Search emails
        </label>
        <input
          id="mail-search"
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search"
          className="h-9 w-full rounded-full border border-transparent bg-muted pr-9 pl-9 text-[13px] text-foreground placeholder:text-subtle-foreground transition-[border-color,background-color,box-shadow] duration-150 outline-none hover:border-border focus:border-primary/50 focus:bg-background focus:ring-3 focus:ring-primary/10 [&::-webkit-search-cancel-button]:hidden"
        />
        {query && (
          <button
            type="button"
            onClick={() => onQueryChange('')}
            aria-label="Clear search"
            className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-subtle-foreground hover:bg-border hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger className={iconButton} aria-label="Filter emails">
          <Filter className="size-4" />
          {activeFilters > 0 && (
            <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-primary" aria-hidden="true" />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Filter by</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={Boolean(filters.starredOnly)}
              onCheckedChange={(checked) => onFiltersChange({ ...filters, starredOnly: checked })}
            >
              Starred
            </DropdownMenuCheckboxItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <button type="button" onClick={onRefresh} className={iconButton} aria-label="Refresh">
        <RotateCw className={cn('size-4', refreshing && 'animate-spin')} />
      </button>
    </div>
  )
}
