"""Keyword retrieval for the Verity Research Systems research assistant.

Searches only the approved local folder ./reports (standard library only).
Usage:  python3 main.py "query"     (no argument runs a built-in demo)

Matching rules (deliberately conservative so unsupported claims get NOT_FOUND):
  * the query is split into keywords; common stopwords are ignored
  * words match whole words only (hyphens split words), with light
    plural/suffix stemming
  * a passage supports the query only if it contains ALL keywords
  * body lines are preferred over titles (line 1); ties go to file name, then
    line number (deterministic)
"""
import re
import sys
from pathlib import Path

APPROVED_DIR = Path(__file__).resolve().parent / "reports"
NOT_FOUND = "NOT_FOUND"

STOPWORDS = frozenset(
    "a an and are as at be by did do does for from how in is it of on or "
    "the to was were what when which who why with".split()
)
# Hyphens split words ("interest-rate" -> interest, rate); . and ' stay inside.
_WORD = re.compile(r"[a-z0-9]+(?:[.'][a-z0-9]+)*")


def _stem(word):
    # Narrow rule: -ier/-iers -> -y (supplier -> supply, carriers -> carry).
    # Only when 4+ letters precede it, so short words (pier, tier) are safe.
    for suffix in ("iers", "ier"):
        if word.endswith(suffix) and len(word) - len(suffix) >= 4:
            return word[: -len(suffix)] + "y"
    for suffix in ("ing", "ed", "es", "s"):
        if word.endswith(suffix) and len(word) - len(suffix) >= 3:
            word = word[: -len(suffix)]
            if len(word) > 3 and word[-1] == word[-2] and word[-1] not in "aeiouls":
                word = word[:-1]  # flagged -> flagg -> flag, running -> run
            break
    if word.endswith("e") and len(word) > 3:  # hedge/hedges, rate/rates
        word = word[:-1]
    return word


def _stems(text):
    return {_stem(w) for w in _WORD.findall(text.lower())}


def _keywords(query):
    words = [w for w in _WORD.findall((query or "").lower()) if w not in STOPWORDS]
    return {_stem(w) for w in words}


def retrieve(query, folder=APPROVED_DIR):
    """Return {'file', 'line', 'excerpt'} for the first supporting line, else None.

    Body lines win over titles (line 1 of a file); a title is returned only
    when no body line in any file supports the query.
    """
    keywords = _keywords(query)
    if not keywords:
        return None
    folder = Path(folder).resolve()
    if not folder.is_dir():
        return None
    title_hit = None
    for path in sorted(folder.glob("*.txt")):
        resolved = path.resolve()
        if folder not in resolved.parents:  # skip symlinks escaping the folder
            continue
        try:
            with open(resolved, encoding="utf-8", errors="replace") as f:
                for num, line in enumerate(f, 1):
                    if keywords <= _stems(line):
                        hit = {"file": path.name, "line": num,
                               "excerpt": line.strip()}
                        if num > 1:
                            return hit
                        title_hit = title_hit or hit
        except OSError:
            continue  # unreadable file: treat as no evidence
    return title_hit


def search(query, folder=APPROVED_DIR):
    """Return 'filename:line: excerpt' for the first match, else NOT_FOUND."""
    hit = retrieve(query, folder)
    if hit is None:
        return NOT_FOUND
    return f"{hit['file']}:{hit['line']}: {hit['excerpt']}"


def demo():
    for q in ("lithium", "hedges floating debt", "bitcoin"):
        print(f"> {q}\n{search(q)}")


def main(argv):
    if len(argv) < 2:
        demo()
    else:
        print(search(" ".join(argv[1:])))


if __name__ == "__main__":
    main(sys.argv)
