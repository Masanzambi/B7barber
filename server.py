import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from getpass import getpass
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, unquote, urlsplit
from urllib.request import Request as UrlRequest, urlopen


ROOT = Path(__file__).resolve().parent
DATABASE_PATH = Path(os.environ.get("B7_DATABASE", ROOT / "b7barber.sqlite3"))
PORT = int(os.environ.get("PORT", "8000"))
SESSION_SECONDS = 7 * 24 * 60 * 60
PASSWORD_ITERATIONS = 600_000
COOKIE_SECURE = os.environ.get("B7_COOKIE_SECURE", "0") == "1"
ALLOWED_SUFFIXES = {".html", ".js", ".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico"}
BARBERS = ("Artur", "Fabio", "Ricardo")
SERVICE_SEEDS = (
    ("Corte", 35, "cabelo"),
    ("Bigode", 5, "barba"),
    ("Cavanhaque", 15, "barba"),
    ("Corte infantil", 40, "cabelo"),
    ("Corte + Barba", 60, "combos"),
    ("Corte + Pigmentação", 60, "combos"),
    ("Hidratação", 15, "quimica"),
    ("Limpeza de Pele", 15, "quimica"),
    ("Sobrancelha", 5, "barba"),
    ("Pezinho", 10, "cabelo"),
    ("Nevou", 100, "quimica"),
    ("Reflexo", 100, "quimica"),
)
PAYMENT_PLANS = {
    "corte": {"name": "Corte", "amount_cents": 8490},
    "barba": {"name": "Barba", "amount_cents": 7990},
    "corte-barba": {"name": "Corte + barba", "amount_cents": 14950},
}
MERCADOPAGO_API_URL = "https://api.mercadopago.com"
DUMMY_PASSWORD = hashlib.pbkdf2_hmac(
    "sha256", b"invalid-account-password", b"b7-dummy-salt", PASSWORD_ITERATIONS
)


def utc_now():
    return datetime.now(timezone.utc).replace(microsecond=0)


def hash_password(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    password_hash = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS
    )
    return salt.hex(), password_hash.hex()


def normalize_phone(phone):
    return re.sub(r"\D", "", phone)


class PaymentProviderError(Exception):
    pass


def mercadopago_api_request(method, path, payload=None, idempotency_key=None):
    access_token = os.environ.get("MERCADOPAGO_ACCESS_TOKEN", "").strip()
    if not access_token:
        raise PaymentProviderError("Configure MERCADOPAGO_ACCESS_TOKEN para iniciar o checkout.")
    if not path.startswith("/") or ".." in path:
        raise PaymentProviderError("Recurso do Mercado Pago inválido.")

    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if idempotency_key:
        headers["X-Idempotency-Key"] = idempotency_key
    request = UrlRequest(
        MERCADOPAGO_API_URL + path,
        data=body,
        headers=headers,
        method=method,
    )
    try:
        with urlopen(request, timeout=12) as response:
            result = json.loads(response.read())
    except HTTPError as error:
        raise PaymentProviderError(f"Mercado Pago retornou HTTP {error.code}.") from error
    except (URLError, TimeoutError, json.JSONDecodeError) as error:
        raise PaymentProviderError("Não foi possível comunicar com o Mercado Pago.") from error
    if not isinstance(result, dict):
        raise PaymentProviderError("Resposta inválida do Mercado Pago.")
    return result


def verify_mercadopago_signature(signature, request_id, data_id, secret):
    if not signature or not request_id or not data_id or not secret:
        return False
    values = {}
    for part in signature.split(","):
        key, separator, value = part.strip().partition("=")
        if separator:
            values[key] = value
    timestamp = values.get("ts", "")
    supplied_signature = values.get("v1", "")
    if not timestamp.isdigit() or not re.fullmatch(r"[0-9a-fA-F]{64}", supplied_signature):
        return False
    manifest = f"id:{str(data_id).lower()};request-id:{request_id};ts:{timestamp};"
    expected_signature = hmac.new(
        secret.encode("utf-8"), manifest.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected_signature, supplied_signature.lower())


class AuthDatabase:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    username TEXT UNIQUE COLLATE NOCASE,
                    phone TEXT NOT NULL UNIQUE,
                    password_salt TEXT NOT NULL,
                    password_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'customer' CHECK(role IN ('customer', 'admin')),
                    is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1))
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    expires_at TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);
                CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
                CREATE TABLE IF NOT EXISTS services (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    price INTEGER NOT NULL CHECK(price >= 0 AND price <= 10000),
                    category TEXT NOT NULL CHECK(category IN ('cabelo', 'barba', 'combos', 'quimica')),
                    is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1))
                );
                CREATE TABLE IF NOT EXISTS barber_availability (
                    barber TEXT NOT NULL CHECK(barber IN ('Artur', 'Fabio', 'Ricardo')),
                    date TEXT NOT NULL,
                    hour INTEGER NOT NULL CHECK(hour BETWEEN 8 AND 21),
                    is_available INTEGER NOT NULL CHECK(is_available IN (0, 1)),
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (barber, date, hour)
                );
                CREATE TABLE IF NOT EXISTS cash_entries (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    barber TEXT NOT NULL CHECK(barber IN ('Artur', 'Fabio', 'Ricardo')),
                    entry_type TEXT NOT NULL CHECK(entry_type IN ('income', 'expense')),
                    amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
                    description TEXT NOT NULL,
                    entry_date TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS cash_entries_date ON cash_entries(entry_date DESC);
                CREATE TABLE IF NOT EXISTS subscriptions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    plan_code TEXT NOT NULL,
                    amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
                    external_reference TEXT NOT NULL UNIQUE,
                    mp_subscription_id TEXT UNIQUE,
                    checkout_url TEXT,
                    status TEXT NOT NULL,
                    next_payment_date TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS subscriptions_user_status
                    ON subscriptions(user_id, status, id DESC);
                CREATE TABLE IF NOT EXISTS subscription_payments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
                    mp_payment_id TEXT NOT NULL UNIQUE,
                    status TEXT NOT NULL,
                    charged_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS subscription_payments_latest
                    ON subscription_payments(subscription_id, charged_at DESC, id DESC);
                """
            )
            columns = {row["name"] for row in connection.execute("PRAGMA table_info(users)")}
            if "role" not in columns:
                connection.execute(
                    "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'customer' CHECK(role IN ('customer', 'admin'))"
                )
            if "username" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN username TEXT")
            connection.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users(username COLLATE NOCASE)"
            )
            if "is_active" not in columns:
                connection.execute(
                    "ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1))"
                )
            connection.executemany(
                "INSERT OR IGNORE INTO services (name, price, category) VALUES (?, ?, ?)", SERVICE_SEEDS
            )

    def connect(self):
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
        return connection

    @staticmethod
    def public_user(row):
        return {
            "id": row["id"],
            "name": row["name"],
            "email": row["email"],
            "phone": row["phone"],
            "role": row["role"],
            "is_active": bool(row["is_active"]),
        }

    def create_session(self, connection, user_id):
        token = secrets.token_urlsafe(32)
        now = utc_now()
        connection.execute(
            "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
            (
                hashlib.sha256(token.encode("ascii")).hexdigest(),
                user_id,
                (now + timedelta(seconds=SESSION_SECONDS)).isoformat(),
                now.isoformat(),
            ),
        )
        connection.execute("DELETE FROM sessions WHERE expires_at <= ?", (now.isoformat(),))
        return token

    def register(self, data):
        name = str(data.get("name", "")).strip()
        email = str(data.get("email", "")).strip().lower()
        phone = normalize_phone(str(data.get("phone", "")))
        password = data.get("password", "")

        if not name or len(name) > 120 or any(ord(char) < 32 for char in name):
            raise ValueError("Informe um nome válido com até 120 caracteres.")
        if len(email) > 254 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
            raise ValueError("Informe um e-mail válido.")
        if not 10 <= len(phone) <= 13:
            raise ValueError("Informe um telefone válido com DDD.")
        if not isinstance(password, str) or len(password) < 8 or len(password) > 128:
            raise ValueError("A senha deve ter entre 8 e 128 caracteres.")

        salt, password_hash = hash_password(password)
        now = utc_now().isoformat()
        with self.connect() as connection:
            try:
                cursor = connection.execute(
                    "INSERT INTO users (name, email, phone, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (name, email, phone, salt, password_hash, now),
                )
            except sqlite3.IntegrityError as error:
                raise ValueError("Este e-mail ou telefone já está cadastrado.") from error
            row = connection.execute("SELECT * FROM users WHERE id = ?", (cursor.lastrowid,)).fetchone()
            token = self.create_session(connection, row["id"])
            return self.public_user(row), token

    def login(self, identifier, password):
        identifier = str(identifier).strip()
        password = password if isinstance(password, str) else ""
        if len(password) > 128:
            return None
        email = identifier.lower()
        phone = normalize_phone(identifier)
        phone_candidates = {phone}
        if phone.startswith("55") and len(phone) in (12, 13):
            phone_candidates.add(phone[2:])
        elif len(phone) in (10, 11):
            phone_candidates.add("55" + phone)
        phone_placeholders = ", ".join("?" for _ in phone_candidates)
        with self.connect() as connection:
            row = connection.execute(
                f"SELECT * FROM users WHERE is_active = 1 AND (email = ? OR username = ? COLLATE NOCASE "
                f"OR phone IN ({phone_placeholders})) LIMIT 1",
                (email, identifier, *phone_candidates),
            ).fetchone()
            if row:
                salt = bytes.fromhex(row["password_salt"])
                expected = bytes.fromhex(row["password_hash"])
                actual = hashlib.pbkdf2_hmac(
                    "sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS
                )
                valid = hmac.compare_digest(actual, expected)
            else:
                actual = hashlib.pbkdf2_hmac(
                    "sha256", password[:128].encode("utf-8"), b"b7-dummy-salt", PASSWORD_ITERATIONS
                )
                hmac.compare_digest(actual, DUMMY_PASSWORD)
                valid = False
            if not row or not valid:
                return None
            token = self.create_session(connection, row["id"])
            return self.public_user(row), token

    def get_user_for_session(self, token):
        if not token:
            return None
        token_hash = hashlib.sha256(token.encode("ascii", errors="ignore")).hexdigest()
        now = utc_now().isoformat()
        with self.connect() as connection:
            row = connection.execute(
                "SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id "
                "WHERE sessions.token_hash = ? AND sessions.expires_at > ?",
                (token_hash, now),
            ).fetchone()
            connection.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
            return self.public_user(row) if row else None

    def revoke_session(self, token):
        if not token:
            return
        token_hash = hashlib.sha256(token.encode("ascii", errors="ignore")).hexdigest()
        with self.connect() as connection:
            connection.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))

    def prepare_subscription(self, user_id, plan_code):
        plan = PAYMENT_PLANS.get(plan_code)
        if not plan:
            raise ValueError("Selecione um plano mensal válido.")
        now = utc_now().isoformat()
        with self.connect() as connection:
            active = connection.execute(
                "SELECT id FROM subscriptions WHERE user_id = ? AND status = 'authorized' LIMIT 1",
                (user_id,),
            ).fetchone()
            if active:
                raise ValueError("Você já possui uma assinatura ativa no B7 Barber Club.")
            pending = connection.execute(
                "SELECT * FROM subscriptions WHERE user_id = ? AND status IN ('creating', 'pending') "
                "ORDER BY id DESC LIMIT 1",
                (user_id,),
            ).fetchone()
            if pending:
                if pending["plan_code"] == plan_code and pending["checkout_url"]:
                    return dict(pending), False
                raise ValueError("Você já possui um checkout de assinatura pendente. Conclua esse checkout primeiro.")
            external_reference = f"b7-{secrets.token_urlsafe(18)}"
            cursor = connection.execute(
                "INSERT INTO subscriptions (user_id, plan_code, amount_cents, external_reference, status, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, 'creating', ?, ?)",
                (user_id, plan_code, plan["amount_cents"], external_reference, now, now),
            )
            row = connection.execute(
                "SELECT * FROM subscriptions WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()
            return dict(row), True

    def set_subscription_checkout(self, subscription_id, provider_result):
        provider_id = str(provider_result.get("id", ""))
        checkout_url = str(provider_result.get("init_point", ""))
        parsed_url = urlsplit(checkout_url)
        valid_hosts = ("mercadopago.com", "mercadopago.com.br")
        if (
            not provider_id
            or len(provider_id) > 100
            or parsed_url.scheme != "https"
            or not parsed_url.hostname
            or not any(
                parsed_url.hostname == host or parsed_url.hostname.endswith("." + host)
                for host in valid_hosts
            )
        ):
            raise PaymentProviderError("Mercado Pago retornou um link de checkout inválido.")
        provider_status = str(provider_result.get("status", "pending")).lower()
        if provider_status not in {"pending", "authorized", "paused", "cancelled", "rejected"}:
            provider_status = "pending"
        with self.connect() as connection:
            cursor = connection.execute(
                "UPDATE subscriptions SET mp_subscription_id = ?, checkout_url = ?, status = ?, updated_at = ? "
                "WHERE id = ? AND status = 'creating'",
                (provider_id, checkout_url, provider_status, utc_now().isoformat(), subscription_id),
            )
            if cursor.rowcount != 1:
                raise PaymentProviderError("Não foi possível salvar o checkout da assinatura.")
            row = connection.execute(
                "SELECT * FROM subscriptions WHERE id = ?", (subscription_id,)
            ).fetchone()
            return dict(row)

    def fail_subscription_checkout(self, subscription_id):
        with self.connect() as connection:
            connection.execute(
                "UPDATE subscriptions SET status = 'checkout_failed', updated_at = ? "
                "WHERE id = ? AND status = 'creating'",
                (utc_now().isoformat(), subscription_id),
            )

    def update_subscription_from_provider(
        self, external_reference, provider_id, provider_status, next_payment_date=None, payment=None
    ):
        known_statuses = {"pending", "authorized", "paused", "cancelled", "rejected"}
        status = str(provider_status or "").lower()
        if status not in known_statuses:
            status = "rejected"
        next_payment_date = str(next_payment_date)[:80] if next_payment_date else None
        with self.connect() as connection:
            row = connection.execute(
                "SELECT id, mp_subscription_id FROM subscriptions WHERE external_reference = ?",
                (str(external_reference),),
            ).fetchone()
            if not row or (row["mp_subscription_id"] and row["mp_subscription_id"] != str(provider_id)):
                return False
            connection.execute(
                "UPDATE subscriptions SET mp_subscription_id = ?, status = ?, next_payment_date = ?, updated_at = ? "
                "WHERE id = ?",
                (str(provider_id), status, next_payment_date, utc_now().isoformat(), row["id"]),
            )
            if payment:
                payment_id = str(payment.get("id", ""))
                payment_status = str(payment.get("status", "")).lower()
                charged_at = str(payment.get("date_created") or utc_now().isoformat())[:80]
                if payment_id and payment_status in {"processed", "recycling", "waiting for gateway", "cancelled"}:
                    connection.execute(
                        "INSERT INTO subscription_payments (subscription_id, mp_payment_id, status, charged_at, updated_at) "
                        "VALUES (?, ?, ?, ?, ?) ON CONFLICT(mp_payment_id) DO UPDATE SET "
                        "status = excluded.status, charged_at = excluded.charged_at, updated_at = excluded.updated_at",
                        (row["id"], payment_id, payment_status, charged_at, utc_now().isoformat()),
                    )
            return True

    def get_subscription_for_user(self, user_id):
        with self.connect() as connection:
            row = connection.execute(
                "SELECT plan_code, amount_cents, status, next_payment_date, created_at "
                "FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1",
                (user_id,),
            ).fetchone()
            if not row:
                return None
            result = dict(row)
            latest_payment = connection.execute(
                "SELECT status, charged_at FROM subscription_payments WHERE subscription_id = "
                "(SELECT id FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1) "
                "ORDER BY charged_at DESC, id DESC LIMIT 1",
                (user_id,),
            ).fetchone()
            payment_is_current = False
            if latest_payment:
                try:
                    charged_at = datetime.fromisoformat(latest_payment["charged_at"].replace("Z", "+00:00"))
                    if charged_at.tzinfo is None:
                        charged_at = charged_at.replace(tzinfo=timezone.utc)
                    payment_is_current = charged_at >= utc_now() - timedelta(days=35)
                except ValueError:
                    payment_is_current = False
            result["active"] = bool(
                result["status"] == "authorized"
                and latest_payment
                and latest_payment["status"] == "processed"
                and payment_is_current
            )
            result["payment_status"] = latest_payment["status"] if latest_payment else None
            result["plan_name"] = PAYMENT_PLANS.get(result["plan_code"], {}).get("name", "")
            return result

    def list_users(self):
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT id, name, email, phone, role, is_active, created_at FROM users ORDER BY created_at DESC"
            ).fetchall()
            return [dict(row) | {"is_active": bool(row["is_active"])} for row in rows]

    def set_user_active(self, user_id, is_active):
        with self.connect() as connection:
            row = connection.execute("SELECT role FROM users WHERE id = ?", (user_id,)).fetchone()
            if not row:
                return False
            if row["role"] == "admin" and not is_active:
                other_admin = connection.execute(
                    "SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1 AND id != ?",
                    (user_id,),
                ).fetchone()[0]
                if not other_admin:
                    raise ValueError("Não é possível desativar o último administrador ativo.")
            connection.execute("UPDATE users SET is_active = ? WHERE id = ?", (int(is_active), user_id))
            if not is_active:
                connection.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
            return True

    def list_services(self, active_only=False):
        query = "SELECT id, name, price, category, is_active FROM services"
        if active_only:
            query += " WHERE is_active = 1"
        query += " ORDER BY id"
        with self.connect() as connection:
            return [dict(row) | {"is_active": bool(row["is_active"])} for row in connection.execute(query)]

    def save_service(self, data, service_id=None):
        name = str(data.get("name", "")).strip()
        category = str(data.get("category", ""))
        is_active = data.get("is_active", True)
        if not name or len(name) > 80:
            raise ValueError("O nome do serviço deve ter entre 1 e 80 caracteres.")
        try:
            price = int(data.get("price"))
        except (TypeError, ValueError) as error:
            raise ValueError("Informe um preço válido em reais.") from error
        if not 0 <= price <= 10000:
            raise ValueError("O preço deve estar entre R$ 0 e R$ 10.000.")
        if category not in {"cabelo", "barba", "combos", "quimica"}:
            raise ValueError("Selecione uma categoria válida.")
        if not isinstance(is_active, bool):
            raise ValueError("O status do serviço é inválido.")
        with self.connect() as connection:
            try:
                if service_id is None:
                    cursor = connection.execute(
                        "INSERT INTO services (name, price, category, is_active) VALUES (?, ?, ?, ?)",
                        (name, price, category, int(is_active)),
                    )
                    service_id = cursor.lastrowid
                else:
                    cursor = connection.execute(
                        "UPDATE services SET name = ?, price = ?, category = ?, is_active = ? WHERE id = ?",
                        (name, price, category, int(is_active), service_id),
                    )
                    if cursor.rowcount == 0:
                        return None
            except sqlite3.IntegrityError as error:
                raise ValueError("Já existe um serviço com esse nome.") from error
            row = connection.execute(
                "SELECT id, name, price, category, is_active FROM services WHERE id = ?", (service_id,)
            ).fetchone()
            return dict(row) | {"is_active": bool(row["is_active"])}

    def set_service_active(self, service_id, is_active):
        with self.connect() as connection:
            cursor = connection.execute(
                "UPDATE services SET is_active = ? WHERE id = ?", (int(is_active), service_id)
            )
            return cursor.rowcount > 0

    def list_availability(self, date):
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT barber, hour, is_available FROM barber_availability WHERE date = ?", (date,)
            ).fetchall()
            availability = {}
            for row in rows:
                availability.setdefault(row["barber"], {})[str(row["hour"])] = bool(row["is_available"])
            return availability

    def set_availability(self, barber, date, hour, is_available):
        if barber not in BARBERS:
            raise ValueError("Selecione um barbeiro válido.")
        try:
            parsed_date = datetime.strptime(date, "%Y-%m-%d").date()
            parsed_hour = int(hour)
        except (TypeError, ValueError) as error:
            raise ValueError("Data ou horário inválido.") from error
        if parsed_date.isoformat() != date or not 8 <= parsed_hour <= 21:
            raise ValueError("Data ou horário fora do expediente (08:00–21:59).")
        if not isinstance(is_available, bool):
            raise ValueError("O estado de disponibilidade é inválido.")
        with self.connect() as connection:
            connection.execute(
                "INSERT INTO barber_availability (barber, date, hour, is_available, updated_at) "
                "VALUES (?, ?, ?, ?, ?) ON CONFLICT(barber, date, hour) DO UPDATE SET "
                "is_available = excluded.is_available, updated_at = excluded.updated_at",
                (barber, date, parsed_hour, int(is_available), utc_now().isoformat()),
            )
        return {"barber": barber, "date": date, "hour": parsed_hour, "is_available": is_available}

    def admin_summary(self):
        today = utc_now().date().isoformat()
        with self.connect() as connection:
            users = connection.execute("SELECT COUNT(*) FROM users WHERE role = 'customer'").fetchone()[0]
            active_users = connection.execute(
                "SELECT COUNT(*) FROM users WHERE role = 'customer' AND is_active = 1"
            ).fetchone()[0]
            services = connection.execute("SELECT COUNT(*) FROM services WHERE is_active = 1").fetchone()[0]
            unavailable = connection.execute(
                "SELECT COUNT(*) FROM barber_availability WHERE date = ? AND is_available = 0", (today,)
            ).fetchone()[0]
            return {
                "customers": users,
                "active_customers": active_users,
                "active_services": services,
                "unavailable_slots_today": unavailable,
            }

    def add_cash_entry(self, data):
        barber = data.get("barber")
        entry_type = data.get("type")
        description = str(data.get("description", "")).strip()
        entry_date = data.get("date")
        if barber not in BARBERS:
            raise ValueError("Selecione um barbeiro válido.")
        if entry_type not in {"income", "expense"}:
            raise ValueError("Selecione entrada ou saída.")
        if not description or len(description) > 120 or any(ord(char) < 32 for char in description):
            raise ValueError("A descrição deve ter entre 1 e 120 caracteres.")
        try:
            parsed_date = datetime.strptime(entry_date, "%Y-%m-%d").date()
            amount = Decimal(str(data.get("amount", ""))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        except (TypeError, ValueError, InvalidOperation) as error:
            raise ValueError("Informe uma data e um valor válidos.") from error
        if parsed_date.isoformat() != entry_date:
            raise ValueError("Informe uma data válida.")
        if not amount.is_finite() or amount <= 0 or amount > Decimal("1000000"):
            raise ValueError("O valor deve ser maior que zero e não ultrapassar R$ 1.000.000,00.")
        amount_cents = int(amount * 100)
        with self.connect() as connection:
            cursor = connection.execute(
                "INSERT INTO cash_entries (barber, entry_type, amount_cents, description, entry_date, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (barber, entry_type, amount_cents, description, entry_date, utc_now().isoformat()),
            )
            row = connection.execute("SELECT * FROM cash_entries WHERE id = ?", (cursor.lastrowid,)).fetchone()
            return {
                "id": row["id"],
                "barber": row["barber"],
                "type": row["entry_type"],
                "amount_cents": row["amount_cents"],
                "description": row["description"],
                "date": row["entry_date"],
            }

    def list_cash_entries(self, limit=100):
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT id, barber, entry_type AS type, amount_cents, description, entry_date AS date "
                "FROM cash_entries ORDER BY entry_date DESC, id DESC LIMIT ?", (limit,)
            ).fetchall()
            return [dict(row) for row in rows]

    def delete_cash_entry(self, entry_id):
        with self.connect() as connection:
            cursor = connection.execute("DELETE FROM cash_entries WHERE id = ?", (entry_id,))
            return cursor.rowcount > 0

    def cash_flow_summary(self):
        today = utc_now().date()
        periods = {
            "week": (today - timedelta(days=today.weekday()), today),
            "month": (today.replace(day=1), today),
            "year": (today.replace(month=1, day=1), today),
        }
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT barber, entry_type, amount_cents, entry_date FROM cash_entries"
            ).fetchall()
        summary = {}
        for period, (start_date, end_date) in periods.items():
            per_barber = {
                barber: {"income_cents": 0, "expense_cents": 0, "profit_cents": 0}
                for barber in BARBERS
            }
            for row in rows:
                if start_date.isoformat() <= row["entry_date"] <= end_date.isoformat():
                    amount_key = "income_cents" if row["entry_type"] == "income" else "expense_cents"
                    per_barber[row["barber"]][amount_key] += row["amount_cents"]
            for totals in per_barber.values():
                totals["profit_cents"] = totals["income_cents"] - totals["expense_cents"]
            summary[period] = {
                "start_date": start_date.isoformat(),
                "end_date": end_date.isoformat(),
                "barbers": [{"name": barber, **per_barber[barber]} for barber in BARBERS],
                "total_income_cents": sum(item["income_cents"] for item in per_barber.values()),
                "total_expense_cents": sum(item["expense_cents"] for item in per_barber.values()),
                "profit_cents": sum(item["profit_cents"] for item in per_barber.values()),
            }
        return summary

    def promote_admin(self, email):
        with self.connect() as connection:
            cursor = connection.execute(
                "UPDATE users SET role = 'admin', is_active = 1 WHERE email = ? COLLATE NOCASE", (email.strip(),)
            )
            return cursor.rowcount > 0

    def set_admin_login(self, email, username, password):
        email = str(email).strip()
        username = str(username).strip()
        if not re.fullmatch(r"[A-Za-z0-9_.-]{3,32}", username):
            raise ValueError("O usuário deve ter de 3 a 32 caracteres: letras, números, ponto, hífen ou sublinhado.")
        if not isinstance(password, str) or len(password) < 8 or len(password) > 128:
            raise ValueError("A senha deve ter entre 8 e 128 caracteres.")

        salt, password_hash = hash_password(password)
        with self.connect() as connection:
            user = connection.execute(
                "SELECT id FROM users WHERE email = ? COLLATE NOCASE", (email,)
            ).fetchone()
            if not user:
                raise ValueError("Conta não encontrada. Cadastre-a primeiro pela página de login.")
            try:
                cursor = connection.execute(
                    "UPDATE users SET username = ?, password_salt = ?, password_hash = ?, "
                    "role = 'admin', is_active = 1 WHERE email = ? COLLATE NOCASE",
                    (username, salt, password_hash, email),
                )
            except sqlite3.IntegrityError as error:
                raise ValueError("Este nome de usuário já está em uso.") from error
            connection.execute("DELETE FROM sessions WHERE user_id = ?", (user["id"],))
            return connection.execute(
                "SELECT id, name, email, username, role, is_active FROM users WHERE email = ? COLLATE NOCASE",
                (email,),
            ).fetchone()

    def create_admin(self, data):
        name = str(data.get("name", "")).strip()
        email = str(data.get("email", "")).strip().lower()
        phone = normalize_phone(str(data.get("phone", "")))
        password = data.get("password", "")

        if not name or len(name) > 120 or any(ord(char) < 32 for char in name):
            raise ValueError("Informe um nome válido com até 120 caracteres.")
        if len(email) > 254 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
            raise ValueError("Informe um e-mail válido.")
        if not 10 <= len(phone) <= 13:
            raise ValueError("Informe um telefone válido com DDD.")
        if not isinstance(password, str) or len(password) < 8 or len(password) > 128:
            raise ValueError("A senha deve ter entre 8 e 128 caracteres.")

        salt, password_hash = hash_password(password)
        with self.connect() as connection:
            try:
                connection.execute(
                    "INSERT INTO users (name, email, phone, password_salt, password_hash, created_at, role) "
                    "VALUES (?, ?, ?, ?, ?, ?, 'admin')",
                    (name, email, phone, salt, password_hash, utc_now().isoformat()),
                )
            except sqlite3.IntegrityError as error:
                raise ValueError("Este e-mail ou telefone já está cadastrado.") from error
            return connection.execute(
                "SELECT id, name, email, phone, role, is_active FROM users WHERE email = ? COLLATE NOCASE",
                (email,),
            ).fetchone()


class AuthHandler(BaseHTTPRequestHandler):
    database = AuthDatabase(DATABASE_PATH)
    server_version = "B7Barber"

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        super().end_headers()

    def send_json(self, status, payload, cookie=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        if self.headers.get_content_type() != "application/json":
            raise ValueError("Formato de solicitação inválido.")
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("Tamanho de solicitação inválido.") from error
        if not 1 <= content_length <= 10_000:
            raise ValueError("Solicitação vazia ou muito grande.")
        try:
            data = json.loads(self.rfile.read(content_length))
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise ValueError("Dados inválidos.") from error
        if not isinstance(data, dict):
            raise ValueError("Dados inválidos.")
        return data

    def valid_origin(self):
        origin = self.headers.get("Origin")
        expected_scheme = "https" if COOKIE_SECURE else "http"
        return origin == f"{expected_scheme}://{self.headers.get('Host', '')}"

    def cookie_token(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except Exception:
            return None
        morsel = cookie.get("b7_session")
        return morsel.value if morsel else None

    def session_cookie(self, token, max_age=SESSION_SECONDS):
        secure = "; Secure" if COOKIE_SECURE else ""
        expires = (utc_now() + timedelta(seconds=max_age)).strftime("%a, %d %b %Y %H:%M:%S GMT")
        return f"b7_session={token}; Path=/; Max-Age={max_age}; Expires={expires}; HttpOnly; SameSite=Lax{secure}"

    def require_admin(self):
        user = self.database.get_user_for_session(self.cookie_token())
        if not user:
            self.send_json(401, {"error": "Entre em uma conta administradora."})
            return False
        if user["role"] != "admin":
            self.send_json(403, {"error": "Acesso restrito à administração."})
            return False
        return True

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/me":
            user = self.database.get_user_for_session(self.cookie_token())
            if not user:
                self.send_json(200, {"authenticated": False, "user": None, "subscription": None})
                return
            self.send_json(200, {
                "authenticated": True,
                "user": user,
                "subscription": self.database.get_subscription_for_user(user["id"]),
            })
            return
        if path == "/api/services":
            self.send_json(200, {"services": self.database.list_services(active_only=True)})
            return
        if path in {"/api/barbers/availability", "/api/admin/availability"}:
            if path.startswith("/api/admin/") and not self.require_admin():
                return
            date = parse_qs(urlsplit(self.path).query).get("date", [""])[0]
            try:
                datetime.strptime(date, "%Y-%m-%d")
            except ValueError:
                self.send_json(400, {"error": "Informe uma data válida."})
                return
            self.send_json(200, {"availability": self.database.list_availability(date)})
            return
        if path.startswith("/api/admin/"):
            if not self.require_admin():
                return
            if path == "/api/admin/summary":
                self.send_json(200, {"summary": self.database.admin_summary()})
            elif path == "/api/admin/users":
                self.send_json(200, {"users": self.database.list_users()})
            elif path == "/api/admin/services":
                self.send_json(200, {"services": self.database.list_services()})
            elif path == "/api/admin/cashflow":
                self.send_json(200, {
                    "summary": self.database.cash_flow_summary(),
                    "entries": self.database.list_cash_entries(),
                })
            else:
                self.send_json(404, {"error": "Rota administrativa não encontrada."})
            return
        self.serve_static(path)

    def do_POST(self):
        path = urlsplit(self.path).path
        webhook_path = "/api/payments/mercadopago/webhook"
        if path not in {
            "/api/register", "/api/login", "/api/logout", "/api/subscriptions",
            "/api/admin/services", "/api/admin/cashflow", webhook_path,
        }:
            self.send_json(404, {"error": "Rota não encontrada."})
            return
        if path == webhook_path:
            self.handle_mercadopago_webhook()
            return
        if not self.valid_origin():
            self.send_json(403, {"error": "Origem não autorizada."})
            return
        if path == "/api/logout":
            self.database.revoke_session(self.cookie_token())
            self.send_json(200, {"message": "Sessão encerrada."}, self.session_cookie("", 0))
            return
        if path == "/api/admin/services":
            if not self.require_admin():
                return
            try:
                service = self.database.save_service(self.read_json())
            except ValueError as error:
                self.send_json(400, {"error": str(error)})
                return
            self.send_json(201, {"service": service})
            return
        if path == "/api/admin/cashflow":
            if not self.require_admin():
                return
            try:
                entry = self.database.add_cash_entry(self.read_json())
            except ValueError as error:
                self.send_json(400, {"error": str(error)})
                return
            self.send_json(201, {"entry": entry})
            return
        if path == "/api/subscriptions":
            self.create_subscription_checkout()
            return
        try:
            data = self.read_json()
            if path == "/api/register":
                user, token = self.database.register(data)
            else:
                result = self.database.login(data.get("identifier", ""), data.get("password", ""))
                if not result:
                    self.send_json(401, {"error": "E-mail/telefone ou senha incorretos."})
                    return
                user, token = result
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
            return
        self.send_json(200 if path == "/api/login" else 201, {"user": user}, self.session_cookie(token))

    def create_subscription_checkout(self):
        user = self.database.get_user_for_session(self.cookie_token())
        if not user:
            self.send_json(401, {"error": "Entre ou crie uma conta antes de assinar."})
            return
        public_url = os.environ.get("B7_PUBLIC_URL", "").strip().rstrip("/")
        parsed_public_url = urlsplit(public_url)
        if (
            not os.environ.get("MERCADOPAGO_ACCESS_TOKEN", "").strip()
            or not os.environ.get("MERCADOPAGO_WEBHOOK_SECRET", "").strip()
            or parsed_public_url.scheme != "https"
            or not parsed_public_url.hostname
            or parsed_public_url.path not in ("", "/")
            or parsed_public_url.query
            or parsed_public_url.fragment
        ):
            self.send_json(503, {
                "error": "Configure credenciais do Mercado Pago, segredo do webhook e B7_PUBLIC_URL HTTPS."
            })
            return
        try:
            data = self.read_json()
            plan_code = data.get("plan")
            subscription, should_create = self.database.prepare_subscription(user["id"], plan_code)
            if not should_create:
                self.send_json(200, {
                    "checkout_url": subscription["checkout_url"],
                    "subscription": self.database.get_subscription_for_user(user["id"]),
                })
                return
            plan = PAYMENT_PLANS[plan_code]
            amount = plan["amount_cents"] / 100
            provider_result = mercadopago_api_request(
                "POST",
                "/preapproval",
                {
                    "reason": f"B7 Barber Club - {plan['name']}",
                    "external_reference": subscription["external_reference"],
                    "payer_email": user["email"],
                    "auto_recurring": {
                        "frequency": 1,
                        "frequency_type": "months",
                        "transaction_amount": amount,
                        "currency_id": "BRL",
                    },
                    "back_url": f"{public_url}/index.html?payment=returned",
                    "notification_url": f"{public_url}/api/payments/mercadopago/webhook",
                    "status": "pending",
                },
                idempotency_key=subscription["external_reference"],
            )
            subscription = self.database.set_subscription_checkout(subscription["id"], provider_result)
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
            return
        except PaymentProviderError as error:
            if "subscription" in locals() and subscription.get("id"):
                self.database.fail_subscription_checkout(subscription["id"])
            self.send_json(502, {"error": str(error)})
            return
        self.send_json(201, {
            "checkout_url": subscription["checkout_url"],
            "subscription": self.database.get_subscription_for_user(user["id"]),
        })

    def handle_mercadopago_webhook(self):
        secret = os.environ.get("MERCADOPAGO_WEBHOOK_SECRET", "").strip()
        if not secret:
            self.send_json(503, {"error": "Webhook do Mercado Pago não configurado."})
            return
        try:
            notification = self.read_json()
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
            return
        query = parse_qs(urlsplit(self.path).query)
        data = notification.get("data")
        data = data if isinstance(data, dict) else {}
        data_id = query.get("data.id", [""])[0] or str(data.get("id", ""))
        request_id = self.headers.get("x-request-id", "")
        if not verify_mercadopago_signature(
            self.headers.get("x-signature", ""), request_id, data_id, secret
        ):
            self.send_json(401, {"error": "Assinatura do webhook inválida."})
            return

        notification_type = notification.get("type") or query.get("type", [""])[0]
        if notification_type not in {"subscription_preapproval", "subscription_authorized_payment"}:
            self.send_json(200, {"received": True, "ignored": True})
            return
        try:
            if notification_type == "subscription_authorized_payment":
                authorized_payment = mercadopago_api_request(
                    "GET", f"/authorized_payments/{quote(data_id, safe='')}"
                )
                subscription_id = str(authorized_payment.get("preapproval_id", ""))
                if not subscription_id:
                    self.send_json(200, {"received": True, "ignored": True})
                    return
            else:
                authorized_payment = None
                subscription_id = data_id
            provider_subscription = mercadopago_api_request(
                "GET", f"/preapproval/{quote(subscription_id, safe='')}"
            )
        except PaymentProviderError as error:
            self.send_json(502, {"error": str(error)})
            return

        updated = self.database.update_subscription_from_provider(
            provider_subscription.get("external_reference", ""),
            provider_subscription.get("id", ""),
            provider_subscription.get("status", ""),
            provider_subscription.get("next_payment_date"),
            authorized_payment,
        )
        self.send_json(200, {"received": True, "updated": updated})

    def do_PUT(self):
        path = urlsplit(self.path).path
        if not path.startswith("/api/admin/"):
            self.send_json(404, {"error": "Rota não encontrada."})
            return
        if not self.valid_origin():
            self.send_json(403, {"error": "Origem não autorizada."})
            return
        if not self.require_admin():
            return
        try:
            data = self.read_json()
            user_match = re.fullmatch(r"/api/admin/users/(\d+)/active", path)
            service_match = re.fullmatch(r"/api/admin/services/(\d+)", path)
            if user_match:
                active = data.get("is_active")
                if not isinstance(active, bool):
                    raise ValueError("O estado da conta é inválido.")
                if not self.database.set_user_active(int(user_match.group(1)), active):
                    self.send_json(404, {"error": "Conta não encontrada."})
                    return
                self.send_json(200, {"message": "Estado da conta atualizado."})
                return
            if service_match:
                service = self.database.save_service(data, int(service_match.group(1)))
                if service is None:
                    self.send_json(404, {"error": "Serviço não encontrado."})
                    return
                self.send_json(200, {"service": service})
                return
            if path == "/api/admin/availability":
                result = self.database.set_availability(
                    data.get("barber"), data.get("date"), data.get("hour"), data.get("is_available")
                )
                self.send_json(200, {"availability": result})
                return
            self.send_json(404, {"error": "Rota administrativa não encontrada."})
        except ValueError as error:
            self.send_json(400, {"error": str(error)})

    def do_DELETE(self):
        path = urlsplit(self.path).path
        cash_match = re.fullmatch(r"/api/admin/cashflow/(\d+)", path)
        if cash_match:
            if not self.valid_origin():
                self.send_json(403, {"error": "Origem não autorizada."})
                return
            if not self.require_admin():
                return
            if not self.database.delete_cash_entry(int(cash_match.group(1))):
                self.send_json(404, {"error": "Lançamento não encontrado."})
                return
            self.send_json(200, {"message": "Lançamento removido."})
            return
        match = re.fullmatch(r"/api/admin/services/(\d+)", path)
        if not match:
            self.send_json(404, {"error": "Rota não encontrada."})
            return
        if not self.valid_origin():
            self.send_json(403, {"error": "Origem não autorizada."})
            return
        if not self.require_admin():
            return
        if not self.database.set_service_active(int(match.group(1)), False):
            self.send_json(404, {"error": "Serviço não encontrado."})
            return
        self.send_json(200, {"message": "Serviço arquivado."})

    def serve_static(self, request_path):
        relative = unquote(request_path).lstrip("/") or "index.html"
        candidate = (ROOT / relative).resolve()
        if ROOT not in candidate.parents or candidate.suffix.lower() not in ALLOWED_SUFFIXES:
            self.send_error(404)
            return
        try:
            content = candidate.read_bytes()
        except OSError:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(candidate.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, format_string, *args):
        print(f"{self.log_date_time_string()} {self.client_address[0]} {format_string % args}")


if __name__ == "__main__" and len(sys.argv) == 3 and sys.argv[1] == "--create-admin":
    email = sys.argv[2]
    name = input("Nome do administrador: ").strip()
    phone = input("Telefone com DDD: ").strip()
    password = getpass("Crie uma senha (8 a 128 caracteres): ")
    confirmation = getpass("Confirme a senha: ")
    if password != confirmation:
        raise SystemExit("As senhas não conferem.")
    try:
        AuthHandler.database.create_admin(
            {"name": name, "email": email, "phone": phone, "password": password}
        )
    except ValueError as error:
        raise SystemExit(str(error)) from error
    print(f"Administrador criado para {email}. Acesse http://127.0.0.1:{PORT}/admin.html")
elif __name__ == "__main__" and len(sys.argv) == 4 and sys.argv[1] == "--set-admin-login":
    email, username = sys.argv[2:]
    password = getpass("Nova senha do administrador: ")
    confirmation = getpass("Confirme a senha: ")
    if password != confirmation:
        raise SystemExit("As senhas não conferem.")
    try:
        AuthHandler.database.set_admin_login(email, username, password)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    print(f"Login administrativo configurado para {username}.")
elif __name__ == "__main__" and len(sys.argv) == 3 and sys.argv[1] == "--promote-admin":
    if AuthHandler.database.promote_admin(sys.argv[2]):
        print(f"Perfil de administrador ativado para {sys.argv[2]}.")
    else:
        raise SystemExit("Conta não encontrada. Cadastre-a primeiro pela página de login.")
elif __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), AuthHandler)
    print(f"B7 Barber disponível em http://127.0.0.1:{PORT}")
    print(f"Banco SQLite: {DATABASE_PATH}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor encerrado.")
    finally:
        server.server_close()