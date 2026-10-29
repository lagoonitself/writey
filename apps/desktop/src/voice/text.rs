//! Turns a reply into words Kokoro can say. Kokoro reads English through a pronunciation
//! lexicon and silently skips words it doesn't know, so numbers, symbols and unknown words
//! become known words here first. The web view already turned LaTeX into words (speech.ts).

use std::collections::HashSet;

const ONES: [&str; 20] = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
];
const TENS: [&str; 10] = [
    "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
];
const SCALES: [(u64, &str); 4] = [
    (1_000_000_000_000, "trillion"),
    (1_000_000_000, "billion"),
    (1_000_000, "million"),
    (1_000, "thousand"),
];

/// 1234 → "one thousand two hundred thirty four".
pub fn number_words(mut n: u64) -> String {
    if n < 20 {
        return ONES[n as usize].into();
    }
    let mut parts: Vec<String> = Vec::new();
    for (scale, name) in SCALES {
        if n >= scale {
            parts.push(format!("{} {name}", number_words(n / scale)));
            n %= scale;
        }
    }
    if n >= 100 {
        parts.push(format!("{} hundred", ONES[(n / 100) as usize]));
        n %= 100;
    }
    if n >= 20 {
        let t = TENS[(n / 10) as usize];
        parts.push(if n % 10 == 0 {
            t.into()
        } else {
            format!("{t} {}", ONES[(n % 10) as usize])
        });
    } else if n > 0 {
        parts.push(ONES[n as usize].into());
    }
    parts.join(" ")
}

fn ordinal_words(n: u64) -> String {
    let w = number_words(n);
    let (head, last) = match w.rsplit_once(' ') {
        Some((h, l)) => (format!("{h} "), l.to_string()),
        None => (String::new(), w.clone()),
    };
    let last = match last.as_str() {
        "one" => "first".into(),
        "two" => "second".into(),
        "three" => "third".into(),
        "five" => "fifth".into(),
        "eight" => "eighth".into(),
        "nine" => "ninth".into(),
        "twelve" => "twelfth".into(),
        l if l.ends_with('y') => format!("{}ieth", &l[..l.len() - 1]),
        l => format!("{l}th"),
    };
    format!("{head}{last}")
}

/// "3.14" → "three point one four"; "-2" → "minus two"; "1,000" → "one thousand".
fn say_number(raw: &str) -> String {
    let neg = raw.starts_with('-');
    let body = raw.trim_start_matches('-').replace(',', "");
    let (int, frac) = match body.split_once('.') {
        Some((i, f)) => (i.to_string(), Some(f.to_string())),
        None => (body.clone(), None),
    };
    let mut out = String::new();
    if neg {
        out.push_str("minus ");
    }
    match int.parse::<u64>() {
        Ok(n) if int.len() <= 15 => out.push_str(&number_words(n)),
        // Too long to read as one number: digit by digit.
        _ => out.push_str(
            &int.chars()
                .filter_map(|c| c.to_digit(10))
                .map(|d| ONES[d as usize])
                .collect::<Vec<_>>()
                .join(" "),
        ),
    }
    if let Some(f) = frac.filter(|f| !f.is_empty()) {
        out.push_str(" point ");
        out.push_str(
            &f.chars()
                .filter_map(|c| c.to_digit(10))
                .map(|d| ONES[d as usize])
                .collect::<Vec<_>>()
                .join(" "),
        );
    }
    out
}

fn symbol_word(c: char) -> Option<&'static str> {
    Some(match c {
        '+' => " plus ",
        '=' => " equals ",
        '×' | '·' => " times ",
        '÷' => " divided by ",
        '−' => " minus ",
        '<' => " is less than ",
        '>' => " is greater than ",
        '≤' => " is at most ",
        '≥' => " is at least ",
        '≠' => " is not equal to ",
        '≈' => " is about ",
        '%' => " percent ",
        '&' => " and ",
        '°' => " degrees ",
        '√' => " the square root of ",
        '∞' => " infinity ",
        'π' => " pi ",
        'θ' => " theta ",
        'α' => " alpha ",
        'β' => " beta ",
        'λ' => " lambda ",
        'μ' => " mu ",
        'Δ' => " delta ",
        '→' | '⇒' => " gives ",
        '^' => " to the power ",
        '/' => " over ",
        '@' => " at ",
        _ => return None,
    })
}

pub struct Speakable<'a> {
    /// Words in the pronunciation lexicon (lower case). Empty: every word is assumed known.
    pub known: &'a HashSet<String>,
}

impl Speakable<'_> {
    fn knows(&self, w: &str) -> bool {
        self.known.is_empty() || self.known.contains(w)
    }

    /// A word Kokoro would skip, said some other way: as known pieces, or letter by letter.
    fn word(&self, w: &str) -> String {
        let lower = w.to_lowercase();
        if lower == "writey" {
            return if self.knows("righty") {
                "righty".into()
            } else {
                "right e".into()
            };
        }
        if self.knows(&lower) {
            return w.into();
        }
        // Acronyms: "DNA", "AC".
        if w.len() <= 5 && w.chars().all(|c| c.is_ascii_uppercase()) {
            return spell(&lower);
        }
        for suffix in ["'s", "’s", "s"] {
            if let Some(stem) = lower.strip_suffix(suffix) {
                if stem.len() > 2 && self.knows(stem) {
                    return w.into();
                }
            }
        }
        if let Some(parts) = self.split(&lower, 3) {
            return parts.join(" ");
        }
        spell(&lower)
    }

    /// Splits an unknown word into at most `max` known words, longest first: "eigenvalue".
    fn split(&self, w: &str, max: usize) -> Option<Vec<String>> {
        if self.known.is_empty() || max == 0 {
            return None;
        }
        let chars: Vec<char> = w.chars().collect();
        for cut in (3..chars.len()).rev() {
            let head: String = chars[..cut].iter().collect();
            if !self.known.contains(&head) {
                continue;
            }
            let tail: String = chars[cut..].iter().collect();
            if tail.chars().count() >= 3 && self.known.contains(&tail) {
                return Some(vec![head, tail]);
            }
            if let Some(mut rest) = self.split(&tail, max - 1) {
                rest.insert(0, head);
                return Some(rest);
            }
        }
        None
    }

    pub fn convert(&self, text: &str) -> String {
        let mut out = String::with_capacity(text.len() + 16);
        let chars: Vec<char> = text.chars().filter(|c| *c != '\0').collect();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            // Numbers, with sign, thousands commas, decimals, ordinals and percent.
            let starts_number = c.is_ascii_digit()
                || ((c == '-' || c == '−')
                    && chars.get(i + 1).is_some_and(char::is_ascii_digit)
                    && (i == 0 || chars[i - 1].is_whitespace() || chars[i - 1] == '('));
            if starts_number {
                let start = i;
                i += 1;
                while i < chars.len()
                    && (chars[i].is_ascii_digit()
                        || ((chars[i] == '.' || chars[i] == ',')
                            && chars.get(i + 1).is_some_and(char::is_ascii_digit)))
                {
                    i += 1;
                }
                let raw: String = chars[start..i]
                    .iter()
                    .map(|&c| if c == '−' { '-' } else { c })
                    .collect();
                let suffix: String = chars[i..].iter().take(2).collect::<String>().to_lowercase();
                let n = raw.replace(',', "");
                if ["st", "nd", "rd", "th"].contains(&suffix.as_str()) && n.parse::<u64>().is_ok() {
                    out.push_str(&ordinal_words(n.parse().unwrap_or(0)));
                    i += 2;
                } else {
                    out.push_str(&say_number(&raw));
                }
                out.push(' ');
                continue;
            }
            if c.is_alphabetic() || c == '\'' || c == '’' {
                let start = i;
                while i < chars.len()
                    && (chars[i].is_alphabetic() || chars[i] == '\'' || chars[i] == '’')
                {
                    i += 1;
                }
                let w: String = chars[start..i].iter().collect();
                let trimmed = w.trim_matches(|c| c == '\'' || c == '’');
                if !trimmed.is_empty() {
                    out.push_str(&self.word(trimmed));
                }
                continue;
            }
            // A dash between words is a pause; between numbers it's "minus" (handled above).
            if let Some(word) = symbol_word(c) {
                out.push_str(word);
            } else if matches!(c, '.' | ',' | '!' | '?' | ';' | ':') {
                out.push(c);
            } else if c == '-' || c == '—' || c == '–' {
                out.push_str(", ");
            } else if c.is_whitespace()
                || matches!(
                    c,
                    '(' | ')' | '"' | '“' | '”' | '*' | '_' | '#' | '[' | ']' | '{' | '}'
                )
            {
                out.push(' ');
            }
            i += 1;
        }
        tidy(&out)
    }
}

fn spell(w: &str) -> String {
    w.chars()
        .filter(|c| c.is_alphabetic())
        .map(|c| c.to_string())
        .collect::<Vec<_>>()
        .join(" ")
}

fn tidy(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut space = false;
    for c in s.chars() {
        if c.is_whitespace() {
            space = !out.is_empty();
            continue;
        }
        if matches!(c, '.' | ',' | '!' | '?' | ';' | ':') {
            space = false;
            // No ", ," runs.
            if out.ends_with([',', ';', ':']) && c == ',' {
                continue;
            }
        } else if space {
            out.push(' ');
        }
        space = false;
        out.push(c);
    }
    out.trim_start_matches([',', ' ']).to_string()
}

/// The words of a pronunciation lexicon file ("word p h o n e s" or "word || p h o n e s").
pub fn lexicon_words(text: &str) -> HashSet<String> {
    text.lines()
        .filter(|l| !l.starts_with('#'))
        .filter_map(|l| {
            let key = l.split(" || ").next().unwrap_or(l);
            let key = if l.contains(" || ") {
                key
            } else {
                key.split_whitespace().next().unwrap_or("")
            };
            (!key.is_empty()).then(|| key.to_lowercase())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn known() -> HashSet<String> {
        [
            "the", "answer", "is", "eigen", "value", "write", "righty", "so", "x", "equals",
            "plus", "dna",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    }

    #[test]
    fn numbers() {
        assert_eq!(number_words(0), "zero");
        assert_eq!(number_words(42), "forty two");
        assert_eq!(number_words(1905), "one thousand nine hundred five");
        assert_eq!(number_words(2_000_013), "two million thirteen");
        assert_eq!(say_number("-3.14"), "minus three point one four");
        assert_eq!(say_number("1,250"), "one thousand two hundred fifty");
        assert_eq!(ordinal_words(21), "twenty first");
        assert_eq!(ordinal_words(40), "fortieth");
    }

    #[test]
    fn sentences() {
        let empty = HashSet::new();
        let s = Speakable { known: &empty };
        assert_eq!(s.convert("x = 2 + 3."), "x equals two plus three.");
        assert_eq!(
            s.convert("It's the 2nd step, 50% done!"),
            "It's the second step, fifty percent done!"
        );
        assert_eq!(
            s.convert("Temperature: −5 °C"),
            "Temperature: minus five degrees C"
        );
        assert_eq!(s.convert("a\0b"), "ab");
    }

    #[test]
    fn unknown_words() {
        let k = known();
        let s = Speakable { known: &k };
        assert_eq!(
            s.convert("Writey says the eigenvalue"),
            "righty s a y s the eigen value"
        );
        assert_eq!(s.convert("so DNA and XYZ"), "so DNA a n d x y z");
    }

    #[test]
    fn reads_lexicons() {
        let w = lexicon_words("# c\nhello h ə l o\nNew York || n j u\nworld w ɜ l d\n");
        assert!(w.contains("hello") && w.contains("new york") && w.contains("world"));
        assert_eq!(w.len(), 3);
    }
}
