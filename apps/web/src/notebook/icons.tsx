// Small stroke icons, drawn on a 24px grid so they share one visual weight.

type P = { size?: number }

function Svg({ size = 20, children }: P & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export const PenIcon = (p: P) => (
  <Svg {...p}>
    <path d="M15.5 4.5l4 4L9 19H5v-4z" />
    <path d="M13 7l4 4" />
  </Svg>
)

export const HighlighterIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9 15l-3 3v2h5l2-2" />
    <path d="M9 15l7.5-10.5a2 2 0 013 0l1 1a2 2 0 010 3L13 19z" />
  </Svg>
)

export const EraserIcon = (p: P) => (
  <Svg {...p}>
    <path d="M8.5 20H20" />
    <path d="M4.6 14.6l9.9-9.9a2 2 0 012.8 0l2 2a2 2 0 010 2.8L11 18.8a4 4 0 01-5.6 0l-.8-.8a2 2 0 010-2.8z" />
    <path d="M9.5 9.7l5 5" />
  </Svg>
)

export const LassoIcon = (p: P) => (
  <Svg {...p}>
    <path d="M7 16.5C4.5 15.4 3 13.5 3 11.3 3 7.3 7 4 12 4s9 3.3 9 7.3-4 7.2-9 7.2c-1 0-2-.1-2.9-.4" />
    <path d="M7 16.5c0 1.5 1 2.5 2.5 2.5S12 20 11 21" />
  </Svg>
)

export const TextIcon = (p: P) => (
  <Svg {...p}>
    <path d="M5 6V4.5h14V6" />
    <path d="M12 4.5v15" />
    <path d="M9 19.5h6" />
  </Svg>
)

export const UndoIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 010 11H11" />
  </Svg>
)

export const RedoIcon = (p: P) => (
  <Svg {...p}>
    <path d="M15 14l5-5-5-5" />
    <path d="M20 9H9.5a5.5 5.5 0 000 11H13" />
  </Svg>
)

export const ImageIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M20.5 16l-4.5-4.5L6 19.5" />
  </Svg>
)

export const PdfIcon = (p: P) => (
  <Svg {...p}>
    <path d="M14 3.5H7a2 2 0 00-2 2v13a2 2 0 002 2h10a2 2 0 002-2v-10z" />
    <path d="M14 3.5v5h5" />
    <path d="M12 11.5v6M9.5 15l2.5 2.5 2.5-2.5" />
  </Svg>
)

export const MinusIcon = (p: P) => (
  <Svg {...p}>
    <path d="M6 12h12" />
  </Svg>
)

export const PlusIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 6v12M6 12h12" />
  </Svg>
)

export const BackIcon = (p: P) => (
  <Svg {...p}>
    <path d="M15 18l-6-6 6-6" />
  </Svg>
)

export const UpIcon = (p: P) => (
  <Svg {...p}>
    <path d="M6 15l6-6 6 6" />
  </Svg>
)

export const DownIcon = (p: P) => (
  <Svg {...p}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
)

export const TrashIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 7h15" />
    <path d="M9.5 7V4.5h5V7" />
    <path d="M6.5 7l1 12.5h9l1-12.5" />
  </Svg>
)

export const EditIcon = (p: P) => (
  <Svg {...p}>
    <path d="M15.5 4.5l4 4L9 19H5v-4z" />
  </Svg>
)

/** Writey's own mark: a sparkle, for anything the AI does. */
export const SparkleIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.5l1.9 5.1a2 2 0 001.2 1.2l5.1 1.9-5.1 1.9a2 2 0 00-1.2 1.2L12 20l-1.9-5.2a2 2 0 00-1.2-1.2L3.8 11.7l5.1-1.9a2 2 0 001.2-1.2z" />
    <path d="M19 3v3M17.5 4.5h3" />
  </Svg>
)

export const GearIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6L18 18M6 18l1.4-1.4M16.6 7.4L18 6" />
  </Svg>
)

export const SendIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Svg>
)

export const StopIcon = (p: P) => (
  <Svg {...p}>
    <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
  </Svg>
)

export const CloseIcon = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
)

export const ChevronIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9 6l6 6-6 6" />
  </Svg>
)

export const SearchIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4 4" />
  </Svg>
)

export const CheckIcon = (p: P) => (
  <Svg {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Svg>
)

export const DownloadIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14" />
  </Svg>
)

export const SignOutIcon = (p: P) => (
  <Svg {...p}>
    <path d="M14 4.5H6.5v15H14M10 12h10M16.5 8.5L20 12l-3.5 3.5" />
  </Svg>
)

/** The ChatGPT logo, for "Continue with ChatGPT" (OpenAI's UI guidelines). */
export const ChatgptIcon = ({ size = 18 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.911 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.182a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .511 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
  </svg>
)

export const GoogleIcon = ({ size = 18 }: P) => (
  <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
    <path
      fill="#FFC107"
      d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.5z"
    />
    <path
      fill="#FF3D00"
      d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
    />
    <path
      fill="#4CAF50"
      d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"
    />
    <path
      fill="#1976D2"
      d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.5z"
    />
  </svg>
)
