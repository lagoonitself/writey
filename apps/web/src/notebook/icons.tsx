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
