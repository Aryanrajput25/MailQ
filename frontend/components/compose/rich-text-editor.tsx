'use client'

import { useEffect, useRef, useState } from 'react'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronsUpDown,
  IndentDecrease,
  IndentIncrease,
  Italic,
  List,
  ListOrdered,
  type LucideIcon,
  Quote,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  Type,
  Underline,
  Undo2,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

type Command =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strikeThrough'
  | 'insertOrderedList'
  | 'insertUnorderedList'
  | 'justifyLeft'
  | 'justifyCenter'
  | 'justifyRight'

const TRACKED: Command[] = [
  'bold',
  'italic',
  'underline',
  'strikeThrough',
  'insertOrderedList',
  'insertUnorderedList',
  'justifyLeft',
  'justifyCenter',
  'justifyRight',
]

const SIZES = [
  { label: 'Small', value: '2', className: 'text-xs' },
  { label: 'Normal', value: '3', className: 'text-sm' },
  { label: 'Large', value: '5', className: 'text-base' },
  { label: 'Huge', value: '6', className: 'text-lg font-medium' },
]

const ALIGNMENTS: { label: string; command: Command; icon: LucideIcon }[] = [
  { label: 'Align left', command: 'justifyLeft', icon: AlignLeft },
  { label: 'Align center', command: 'justifyCenter', icon: AlignCenter },
  { label: 'Align right', command: 'justifyRight', icon: AlignRight },
]

interface RichTextEditorProps {
  onChange: (html: string) => void
  placeholder?: string
  invalid?: boolean
  onSubmitShortcut?: () => void
}

const toolButton =
  'flex h-7 min-w-7 items-center justify-center gap-0.5 rounded-md px-1 text-muted-foreground transition-colors duration-150 outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 aria-pressed:bg-accent aria-pressed:text-accent-foreground data-popup-open:bg-muted'

function Divider() {
  return <span className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden="true" />
}

export function RichTextEditor({ onChange, placeholder, invalid, onSubmitShortcut }: RichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const savedRange = useRef<Range | null>(null)
  const [active, setActive] = useState<Partial<Record<Command, boolean>>>({})

  useEffect(() => {
    function handleSelection() {
      const editor = editorRef.current
      const selection = document.getSelection()
      if (!editor || !selection?.rangeCount) return
      const range = selection.getRangeAt(0)
      if (!editor.contains(range.commonAncestorContainer)) return
      savedRange.current = range.cloneRange()
      setActive(Object.fromEntries(TRACKED.map((c) => [c, document.queryCommandState(c)])))
    }
    document.addEventListener('selectionchange', handleSelection)
    return () => document.removeEventListener('selectionchange', handleSelection)
  }, [])

  function emitChange() {
    const editor = editorRef.current
    if (!editor) return
    const isEmpty = !editor.textContent?.trim() && !editor.querySelector('li')
    if (isEmpty && editor.innerHTML !== '') editor.innerHTML = ''
    onChange(isEmpty ? '' : editor.innerHTML)
  }

  function restoreSelection() {
    const editor = editorRef.current
    if (!editor) return
    editor.focus()
    const selection = document.getSelection()
    if (savedRange.current && selection) {
      selection.removeAllRanges()
      selection.addRange(savedRange.current)
    }
  }

  function exec(command: string, value?: string) {
    restoreSelection()
    document.execCommand('styleWithCSS', false, 'false')
    document.execCommand(command, false, value)
    emitChange()
    setActive(Object.fromEntries(TRACKED.map((c) => [c, document.queryCommandState(c)])))
  }

  function Tool({ label, icon: Icon, command, value }: { label: string; icon: LucideIcon; command: string; value?: string }) {
    const tracked = TRACKED.includes(command as Command)
    return (
      <button
        type="button"
        title={label}
        aria-label={label}
        aria-pressed={tracked ? Boolean(active[command as Command]) : undefined}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => exec(command, value)}
        className={toolButton}
      >
        <Icon className="size-4" />
      </button>
    )
  }

  const currentAlignment = ALIGNMENTS.find((a) => active[a.command]) ?? ALIGNMENTS[0]

  return (
    <div
      className={cn(
        'flex min-h-80 flex-1 flex-col rounded-xl border bg-subtle transition-[border-color,box-shadow] duration-150 focus-within:border-primary/40 focus-within:ring-3 focus-within:ring-primary/10',
        invalid ? 'border-destructive/60' : 'border-transparent',
      )}
    >
      <div
        role="toolbar"
        aria-label="Formatting"
        className="mx-2 mt-2 flex items-center gap-0.5 overflow-x-auto rounded-lg border border-border bg-background px-1.5 py-1 [scrollbar-width:none]"
      >
        <Tool label="Undo" icon={Undo2} command="undo" />
        <Tool label="Redo" icon={Redo2} command="redo" />
        <Divider />
        <DropdownMenu>
          <DropdownMenuTrigger className={toolButton} aria-label="Text size" onMouseDown={(e) => e.preventDefault()}>
            <Type className="size-4" />
            <ChevronsUpDown className="size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-36">
            {SIZES.map((size) => (
              <DropdownMenuItem key={size.value} onClick={() => exec('fontSize', size.value)}>
                <span className={size.className}>{size.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Divider />
        <Tool label="Bold" icon={Bold} command="bold" />
        <Tool label="Italic" icon={Italic} command="italic" />
        <Tool label="Underline" icon={Underline} command="underline" />
        <Divider />
        <DropdownMenu>
          <DropdownMenuTrigger className={toolButton} aria-label="Text alignment" onMouseDown={(e) => e.preventDefault()}>
            <currentAlignment.icon className="size-4" />
            <ChevronsUpDown className="size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-40">
            {ALIGNMENTS.map(({ label, command, icon: Icon }) => (
              <DropdownMenuItem key={command} onClick={() => exec(command)}>
                <Icon />
                {label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Divider />
        <Tool label="Numbered list" icon={ListOrdered} command="insertOrderedList" />
        <Tool label="Bulleted list" icon={List} command="insertUnorderedList" />
        <Tool label="Indent" icon={IndentIncrease} command="indent" />
        <Tool label="Outdent" icon={IndentDecrease} command="outdent" />
        <Tool label="Quote" icon={Quote} command="formatBlock" value="blockquote" />
        <Tool label="Clear formatting" icon={RemoveFormatting} command="removeFormat" />
        <Divider />
        <Tool label="Strikethrough" icon={Strikethrough} command="strikeThrough" />
      </div>

      <div
        ref={editorRef}
        role="textbox"
        aria-multiline="true"
        aria-label="Email body"
        aria-invalid={invalid || undefined}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onInput={emitChange}
        onPaste={(e) => {
          e.preventDefault()
          document.execCommand('insertText', false, e.clipboardData.getData('text/plain'))
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            e.preventDefault()
            onSubmitShortcut?.()
          }
        }}
        className="editor-surface email-prose flex-1 px-4 py-4 text-sm outline-none md:px-5"
      />
    </div>
  )
}
