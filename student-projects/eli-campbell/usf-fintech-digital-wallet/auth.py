"""Demo sign-in for the fictional wallet (no UI imports).

The password is never stored. Only a random salt and a PBKDF2 hash are written to a local file.
This is demo-grade protection for a mock app, not a production authentication system.
"""
import hashlib
import hmac
import json
import os

ITERATIONS = 200_000
MIN_PASSWORD_LENGTH = 8
DEFAULT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".wallet_credentials.json")


def hash_password(password, salt=None):
    """Return (salt_hex, hash_hex). A fresh random salt is used when none is given."""
    salt_bytes = bytes.fromhex(salt) if salt else os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt_bytes, ITERATIONS)
    return salt_bytes.hex(), digest.hex()


DEMO_USERNAME = "localhost"
DEMO_PASSWORD = "money123"  # shown on the sign-in screen by request; demo app with fictional money


def ensure_demo_account(path=DEFAULT_PATH):
    """Create the Wallet A demo account (stored hashed) if no account exists yet."""
    if not has_account(path):
        create_account(DEMO_USERNAME, DEMO_PASSWORD, "A", path)


def has_account(path=DEFAULT_PATH):
    return os.path.exists(path)


def create_account(username, password, wallet="A", path=DEFAULT_PATH):
    """Save a new account. Returns an error message, or None on success."""
    username = (username or "").strip()
    if not username:
        return "Username is required."
    if len(password or "") < MIN_PASSWORD_LENGTH:
        return f"Password must be at least {MIN_PASSWORD_LENGTH} characters."
    if has_account(path):
        return "An account already exists."
    salt, digest = hash_password(password)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"username": username, "wallet": wallet, "salt": salt, "hash": digest,
                   "iterations": ITERATIONS}, f)
    return None


def verify_login(username, password, path=DEFAULT_PATH):
    """Return the wallet the account owns if the credentials match, otherwise None."""
    if not has_account(path):
        return None
    with open(path) as f:
        record = json.load(f)
    _, digest = hash_password(password or "", record["salt"])
    name_ok = (username or "").strip().casefold() == record["username"].casefold()
    pass_ok = hmac.compare_digest(digest, record["hash"])
    return record["wallet"] if (name_ok and pass_ok) else None
