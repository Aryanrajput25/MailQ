import { FileText, X } from 'lucide-react'
import { formatFileSize } from '@/lib/format'
import type { Attachment } from '@/lib/types'

interface AttachmentCardProps {
  attachment: Attachment
  onRemove?: (id: string) => void
}

export function AttachmentCard({ attachment, onRemove }: AttachmentCardProps) {
  const isImage = attachment.mimeType.startsWith('image/')

  return (
    <figure className="group relative w-full overflow-hidden rounded-lg border border-border bg-secondary transition-shadow duration-150 hover:shadow-[0_4px_16px_-8px_rgba(23,26,25,0.2)] sm:w-48">
      <a
        href={attachment.url}
        target="_blank"
        rel="noopener noreferrer"
        className="block outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
        aria-label={`Open ${attachment.name}`}
      >
        <div className="flex aspect-[16/9] items-center justify-center overflow-hidden bg-muted">
          {isImage ? (
            // eslint-disable-next-line @next/next/no-img-element -- supports local object URLs from uploads
            <img src={attachment.url} alt="" className="size-full object-cover" />
          ) : (
            <FileText className="size-7 text-subtle-foreground" aria-hidden="true" />
          )}
        </div>
        <figcaption className="px-2.5 py-2">
          <p className="truncate text-xs font-medium text-foreground">{attachment.name}</p>
          <p className="text-[11px] text-subtle-foreground">{formatFileSize(attachment.sizeBytes)}</p>
        </figcaption>
      </a>
      {onRemove && (
        <button
          type="button"
          onClick={() => onRemove(attachment.id)}
          aria-label={`Remove ${attachment.name}`}
          className="absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-full bg-foreground/70 text-background opacity-100 transition-opacity hover:bg-foreground sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
        >
          <X className="size-3.5" />
        </button>
      )}
    </figure>
  )
}
