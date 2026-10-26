import { PTT_LABEL } from './useVoice'

const GROUPS: { title: string; where: string; say: string[] }[] = [
  {
    title: 'Work it out on the page',
    where: 'Writey writes the next step in handwriting',
    say: ["Hey, what's next?", 'Hey, solve this', 'Hey, continue'],
  },
  {
    title: 'Understand it',
    where: 'Writey sketches it on the page, explains beside it, and out loud',
    say: ['Hey, why does this work?', 'Hey, explain the full adder', 'Hey, give me a hint'],
  },
  {
    title: 'Check your work',
    where: 'Red marks on the page, and what went wrong',
    say: ['Hey, is this right?', 'Hey, find my mistake'],
  },
]

const AFTER = ['Keep it', 'Scrap that', 'Redo', 'Stop']

/** How to talk to Writey: what to say, and what happens. */
export function VoiceGuide({
  onTry,
  compact = false,
}: {
  /** Asks the example as if it had been said. */
  onTry?(text: string): void
  compact?: boolean
}) {
  return (
    <div className={`voice-guide${compact ? ' compact' : ''}`}>
      {GROUPS.map((g) => (
        <section key={g.title}>
          <h4>{g.title}</h4>
          <p>{g.where}</p>
          <div className="voice-guide-says">
            {g.say.map((s) =>
              onTry ? (
                <button type="button" key={s} onClick={() => onTry(s.replace(/^Hey, /, ''))}>
                  “{s}”
                </button>
              ) : (
                <span key={s}>“{s}”</span>
              ),
            )}
          </div>
        </section>
      ))}
      <section>
        <h4>Then</h4>
        <p>While Writey’s ink is shown in violet:</p>
        <div className="voice-guide-says">
          {AFTER.map((s) => (
            <span key={s}>“{s}”</span>
          ))}
        </div>
      </section>
      {!compact && (
        <ul className="voice-guide-tips">
          <li>After Writey answers, just reply. You don’t need to say “Hey” again.</li>
          <li>
            Hold <kbd>{PTT_LABEL}</kbd> to talk without the wake word (map a pen button to it).
          </li>
          <li>Lasso part of the page to point Writey at it.</li>
          <li>Talk over Writey to interrupt it.</li>
          <li>Ask something new and Writey keeps what it wrote, then carries on below it.</li>
        </ul>
      )}
    </div>
  )
}
