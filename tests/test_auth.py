import json
import tempfile
import threading
import unittest
from http.cookiejar import CookieJar
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, Request, build_opener
from http.server import ThreadingHTTPServer

from server import AuthDatabase, AuthHandler, utc_now


class AuthApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_directory = tempfile.TemporaryDirectory()
        database = AuthDatabase(Path(self.temp_directory.name) / "test.sqlite3")
        handler = type("TestAuthHandler", (AuthHandler,), {"database": database})
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"
        self.opener = build_opener(HTTPCookieProcessor(CookieJar()))

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join(timeout=2)
        self.temp_directory.cleanup()

    def request(self, path, payload=None, include_origin=True, method=None):
        data = json.dumps(payload or {}).encode("utf-8") if payload is not None else None
        headers = {}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if include_origin:
            headers["Origin"] = self.base_url
        request = Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            response = self.opener.open(request)
        except HTTPError as error:
            response = error
        return response.code, json.loads(response.read())

    def register(self):
        return self.request(
            "/api/register",
            {
                "name": "Cliente B7",
                "email": "cliente@example.com",
                "phone": "+55 (21) 99999-1234",
                "password": "Senha-segura-123",
            },
        )

    def test_register_creates_hashed_user_and_session(self):
        status, result = self.register()
        self.assertEqual(status, 201)
        self.assertEqual(result["user"]["email"], "cliente@example.com")
        self.assertNotIn("password", result["user"])
        self.assertEqual(self.request("/api/me")[1]["user"]["name"], "Cliente B7")

        with AuthDatabase(Path(self.temp_directory.name) / "test.sqlite3").connect() as connection:
            password_hash = connection.execute("SELECT password_hash FROM users").fetchone()[0]
        self.assertNotEqual(password_hash, "Senha-segura-123")

    def test_create_admin_creates_admin_profile_with_hashed_password(self):
        database = self.server.RequestHandlerClass.database
        admin = database.create_admin({
            "name": "Admin Inicial",
            "email": "admin@example.com",
            "phone": "+55 (21) 99999-1234",
            "password": "Senha-admin-2026",
        })
        self.assertEqual(admin["role"], "admin")
        self.assertEqual(admin["email"], "admin@example.com")

        with database.connect() as connection:
            stored_hash = connection.execute(
                "SELECT password_hash FROM users WHERE email = ?", ("admin@example.com",)
            ).fetchone()[0]
        self.assertNotEqual(stored_hash, "Senha-admin-2026")
        self.assertIsNotNone(database.login("admin@example.com", "Senha-admin-2026"))

        with self.assertRaisesRegex(ValueError, "já está cadastrado"):
            database.create_admin({
                "name": "Outro Admin",
                "email": "ADMIN@example.com",
                "phone": "21988887766",
                "password": "Senha-admin-2026",
            })

    def test_login_accepts_email_or_phone_and_rejects_wrong_password(self):
        self.assertEqual(self.register()[0], 201)
        self.request("/api/logout", {})

        status, result = self.request(
            "/api/login", {"identifier": "(21) 99999-1234", "password": "Senha-segura-123"}
        )
        self.assertEqual(status, 200)
        self.assertEqual(result["user"]["name"], "Cliente B7")

        self.request("/api/logout", {})
        status, result = self.request(
            "/api/login", {"identifier": "cliente@example.com", "password": "senha-errada"}
        )
        self.assertEqual(status, 401)
        status, session = self.request("/api/me")
        self.assertEqual(status, 200)
        self.assertFalse(session["authenticated"])

    def test_admin_login_accepts_configured_username(self):
        self.assertEqual(self.register()[0], 201)
        database = self.server.RequestHandlerClass.database
        self.assertTrue(self.request("/api/me")[1]["authenticated"])
        admin = database.set_admin_login(
            "cliente@example.com", "Barber07", "barber2026"
        )
        self.assertEqual(admin["role"], "admin")
        self.assertFalse(self.request("/api/me")[1]["authenticated"])
        status, result = self.request(
            "/api/login", {"identifier": "Barber07", "password": "barber2026"}
        )
        self.assertEqual(status, 200)
        self.assertEqual(result["user"]["role"], "admin")
        self.assertIsNone(database.login("Barber07", "senha-errada"))

    def test_anonymous_session_check_is_not_an_error(self):
        status, result = self.request("/api/me")
        self.assertEqual(status, 200)
        self.assertEqual(result, {"authenticated": False, "user": None, "subscription": None})

    def test_duplicate_email_or_phone_is_rejected(self):
        self.assertEqual(self.register()[0], 201)
        status, result = self.request(
            "/api/register",
            {
                "name": "Outra Pessoa",
                "email": "CLIENTE@example.com",
                "phone": "21988887777",
                "password": "Senha-segura-456",
            },
        )
        self.assertEqual(status, 400)
        self.assertIn("já está cadastrado", result["error"])

    def test_state_changing_request_requires_same_origin(self):
        status, result = self.request("/api/register", {
            "name": "Cliente B7",
            "email": "cliente@example.com",
            "phone": "21999991234",
            "password": "Senha-segura-123",
        }, include_origin=False)
        self.assertEqual(status, 403)
        self.assertIn("Origem", result["error"])

    def test_short_password_is_rejected(self):
        status, result = self.request(
            "/api/register",
            {
                "name": "Cliente B7",
                "email": "cliente@example.com",
                "phone": "21999991234",
                "password": "1234567",
            },
        )
        self.assertEqual(status, 400)
        self.assertIn("8 e 128", result["error"])

    def test_oversized_login_password_is_rejected(self):
        status, result = self.request(
            "/api/login",
            {"identifier": "missing@example.com", "password": "x" * 129},
        )
        self.assertEqual(status, 401)
        self.assertEqual(result["error"], "E-mail/telefone ou senha incorretos.")

    def test_customer_cannot_access_admin_api(self):
        self.assertEqual(self.register()[0], 201)
        status, result = self.request("/api/admin/users")
        self.assertEqual(status, 403)
        self.assertIn("administração", result["error"])

    def test_admin_changes_services_and_shared_availability(self):
        self.assertEqual(self.register()[0], 201)
        self.assertTrue(self.server.RequestHandlerClass.database.promote_admin("cliente@example.com"))
        status, result = self.request("/api/admin/summary")
        self.assertEqual(status, 200)
        self.assertEqual(result["summary"]["active_services"], 12)

        status, result = self.request(
            "/api/admin/services/1",
            {"name": "Corte", "price": 42, "category": "cabelo", "is_active": True},
            method="PUT",
        )
        self.assertEqual(status, 200)
        public_services = self.request("/api/services")[1]["services"]
        self.assertEqual(next(service for service in public_services if service["id"] == 1)["price"], 42)

        status, result = self.request(
            "/api/admin/availability",
            {"barber": "Artur", "date": "2026-09-27", "hour": 8, "is_available": False},
            method="PUT",
        )
        self.assertEqual(status, 200)
        public_slots = self.request("/api/barbers/availability?date=2026-09-27")[1]["availability"]
        self.assertFalse(public_slots["Artur"]["8"])

    def test_admin_cashflow_tracks_barber_income_expenses_and_deletion(self):
        self.assertEqual(self.register()[0], 201)
        database = self.server.RequestHandlerClass.database
        self.assertTrue(database.promote_admin("cliente@example.com"))
        today = utc_now().date().isoformat()
        status, income = self.request("/api/admin/cashflow", {
            "barber": "Artur", "type": "income", "amount": "150.75",
            "description": "Cortes", "date": today,
        })
        self.assertEqual(status, 201)
        status, expense = self.request("/api/admin/cashflow", {
            "barber": "Artur", "type": "expense", "amount": "25.50",
            "description": "Produtos", "date": today,
        })
        self.assertEqual(status, 201)

        status, result = self.request("/api/admin/cashflow")
        self.assertEqual(status, 200)
        for period in ("week", "month", "year"):
            artur = next(row for row in result["summary"][period]["barbers"] if row["name"] == "Artur")
            self.assertEqual(artur["income_cents"], 15075)
            self.assertEqual(artur["expense_cents"], 2550)
            self.assertEqual(artur["profit_cents"], 12525)
        self.assertEqual(result["entries"][0]["date"], today)

        status, result = self.request(
            f"/api/admin/cashflow/{expense['entry']['id']}", method="DELETE"
        )
        self.assertEqual(status, 200)
        refreshed = self.request("/api/admin/cashflow")[1]["summary"]["week"]
        artur = next(row for row in refreshed["barbers"] if row["name"] == "Artur")
        self.assertEqual(artur["profit_cents"], 15075)

    def test_customer_cannot_read_or_create_cash_entries(self):
        self.assertEqual(self.register()[0], 201)
        status, result = self.request("/api/admin/cashflow")
        self.assertEqual(status, 403)
        status, result = self.request("/api/admin/cashflow", {
            "barber": "Artur", "type": "income", "amount": "20",
            "description": "Serviço", "date": utc_now().date().isoformat(),
        })
        self.assertEqual(status, 403)

    def test_customer_cannot_create_admin_service(self):
        self.assertEqual(self.register()[0], 201)
        status, result = self.request(
            "/api/admin/services",
            {"name": "Serviço indevido", "price": 25, "category": "cabelo", "is_active": True},
        )
        self.assertEqual(status, 403)

    def test_admin_can_disable_customer_and_revoke_sessions(self):
        self.assertEqual(self.register()[0], 201)
        database = self.server.RequestHandlerClass.database
        self.assertTrue(database.promote_admin("cliente@example.com"))
        customer, customer_token = database.register({
            "name": "Conta para desativar",
            "email": "inativa@example.com",
            "phone": "21988887766",
            "password": "Senha-segura-456",
        })
        status, result = self.request(
            f"/api/admin/users/{customer['id']}/active", {"is_active": False}, method="PUT"
        )
        self.assertEqual(status, 200)
        self.assertIsNone(database.get_user_for_session(customer_token))


if __name__ == "__main__":
    unittest.main()
