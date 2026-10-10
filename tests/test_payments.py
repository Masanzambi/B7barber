import hashlib
import hmac
import json
import os
import tempfile
import threading
import unittest
from http.cookiejar import CookieJar
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, Request, build_opener
from unittest.mock import patch
from pathlib import Path

from server import AuthDatabase, AuthHandler


class SubscriptionApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_directory = tempfile.TemporaryDirectory()
        self.database = AuthDatabase(Path(self.temp_directory.name) / "payments.sqlite3")
        handler = type("TestPaymentHandler", (AuthHandler,), {"database": self.database})
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

    def request(self, path, payload=None, headers=None):
        request_headers = {"Origin": self.base_url}
        request_headers.update(headers or {})
        data = None
        if payload is not None:
            request_headers.setdefault("Content-Type", "application/json")
            data = json.dumps(payload).encode("utf-8")
        request = Request(self.base_url + path, data=data, headers=request_headers)
        try:
            response = self.opener.open(request)
        except HTTPError as error:
            response = error
        return response.code, json.loads(response.read())

    def register_user(self):
        status, result = self.request("/api/register", {
            "name": "Cliente B7",
            "email": "cliente@example.com",
            "phone": "21999991234",
            "password": "Senha-segura-123",
        })
        self.assertEqual(status, 201)
        return result["user"]

    def create_pending_subscription(self, plan="barba"):
        user = self.register_user()
        response = {
            "id": "mp-subscription-123",
            "init_point": "https://www.mercadopago.com.br/subscriptions/checkout?id=123",
            "status": "pending",
        }
        with patch.dict(os.environ, {
            "MERCADOPAGO_ACCESS_TOKEN": "TEST-token",
            "MERCADOPAGO_WEBHOOK_SECRET": "webhook-test-secret",
            "B7_PUBLIC_URL": "https://b7-test.example",
        }), patch("server.mercadopago_api_request", return_value=response) as provider_request:
            status, result = self.request("/api/subscriptions", {"plan": plan})
        self.assertEqual(status, 201)
        return result, provider_request, user

    def test_checkout_uses_server_price_and_monthly_brl(self):
        result, provider_request, user = self.create_pending_subscription("barba")
        self.assertEqual(result["checkout_url"], "https://www.mercadopago.com.br/subscriptions/checkout?id=123")
        self.assertEqual(result["subscription"]["status"], "pending")
        args, kwargs = provider_request.call_args
        self.assertEqual(args[:2], ("POST", "/preapproval"))
        payload = args[2]
        self.assertEqual(payload["auto_recurring"], {
            "frequency": 1,
            "frequency_type": "months",
            "transaction_amount": 79.9,
            "currency_id": "BRL",
        })
        self.assertEqual(payload["status"], "pending")
        self.assertEqual(payload["payer_email"], "cliente@example.com")
        self.assertEqual(
            kwargs["idempotency_key"], payload["external_reference"]
        )

    def test_checkout_requires_authenticated_user(self):
        with patch.dict(os.environ, {
            "MERCADOPAGO_ACCESS_TOKEN": "TEST-token",
            "MERCADOPAGO_WEBHOOK_SECRET": "webhook-test-secret",
            "B7_PUBLIC_URL": "https://b7-test.example",
        }), patch("server.mercadopago_api_request") as provider_request:
            status, result = self.request("/api/subscriptions", {"plan": "corte"})
        self.assertEqual(status, 401)
        provider_request.assert_not_called()

    def test_checkout_reports_missing_sandbox_configuration(self):
        self.register_user()
        with patch.dict(os.environ, {}, clear=True), patch("server.mercadopago_api_request") as provider_request:
            status, result = self.request("/api/subscriptions", {"plan": "corte"})
        self.assertEqual(status, 503)
        self.assertIn("Configure credenciais", result["error"])
        provider_request.assert_not_called()

    def test_client_cannot_choose_subscription_price(self):
        self.register_user()
        with patch.dict(os.environ, {
            "MERCADOPAGO_ACCESS_TOKEN": "TEST-token",
            "MERCADOPAGO_WEBHOOK_SECRET": "webhook-test-secret",
            "B7_PUBLIC_URL": "https://b7-test.example",
        }), patch("server.mercadopago_api_request") as provider_request:
            status, result = self.request("/api/subscriptions", {"plan": "unknown", "amount": 1})
        self.assertEqual(status, 400)
        self.assertIn("plano mensal", result["error"])
        provider_request.assert_not_called()

    def test_invalid_webhook_signature_does_not_update_membership(self):
        result, _, user = self.create_pending_subscription()
        with patch.dict(os.environ, {"MERCADOPAGO_WEBHOOK_SECRET": "webhook-test-secret"}), patch(
            "server.mercadopago_api_request"
        ) as provider_request:
            status, response = self.request(
                "/api/payments/mercadopago/webhook?data.id=mp-subscription-123&type=subscription_preapproval",
                {"type": "subscription_preapproval", "data": {"id": "mp-subscription-123"}},
                {"x-request-id": "request-1", "x-signature": "ts=1,v1=" + "0" * 64},
            )
        self.assertEqual(status, 401)
        self.assertFalse(self.database.get_subscription_for_user(user["id"])["active"])
        provider_request.assert_not_called()

    def test_valid_webhook_fetches_provider_state_before_activating(self):
        result, _, user = self.create_pending_subscription()
        request_id = "request-2"
        timestamp = "1704908010"
        subscription_id = "mp-subscription-123"
        payment_id = "mp-payment-789"
        manifest = f"id:{payment_id};request-id:{request_id};ts:{timestamp};"
        signature = hmac.new(
            b"webhook-test-secret", manifest.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        with self.database.connect() as connection:
            external_reference = connection.execute(
                "SELECT external_reference FROM subscriptions WHERE user_id = ?", (user["id"],)
            ).fetchone()[0]
        with patch.dict(os.environ, {"MERCADOPAGO_WEBHOOK_SECRET": "webhook-test-secret"}), patch(
            "server.mercadopago_api_request",
            side_effect=[
                {"id": payment_id, "preapproval_id": subscription_id, "status": "processed", "date_created": "2026-10-08T22:00:00-03:00"},
                {
                    "id": subscription_id,
                    "external_reference": external_reference,
                    "status": "authorized",
                    "next_payment_date": "2026-11-08T00:00:00.000-03:00",
                },
            ],
        ) as provider_request:
            status, response = self.request(
                f"/api/payments/mercadopago/webhook?data.id={payment_id}&type=subscription_authorized_payment",
                {"type": "subscription_authorized_payment", "data": {"id": payment_id}},
                {"x-request-id": request_id, "x-signature": f"ts={timestamp},v1={signature}"},
            )
        self.assertEqual(status, 200)
        self.assertTrue(response["updated"])
        self.assertEqual(provider_request.call_args_list[0].args, ("GET", "/authorized_payments/mp-payment-789"))
        self.assertEqual(provider_request.call_args_list[1].args, ("GET", "/preapproval/mp-subscription-123"))
        membership = self.database.get_subscription_for_user(user["id"])
        self.assertTrue(membership["active"])
        self.assertEqual(membership["status"], "authorized")
        self.assertEqual(membership["payment_status"], "processed")
        self.assertEqual(membership["next_payment_date"], "2026-11-08T00:00:00.000-03:00")

    def test_active_subscription_blocks_new_checkout(self):
        result, _, user = self.create_pending_subscription()
        with self.database.connect() as connection:
            external_reference = connection.execute(
                "SELECT external_reference FROM subscriptions WHERE user_id = ?", (user["id"],)
            ).fetchone()[0]
        self.database.update_subscription_from_provider(
            external_reference,
            "mp-subscription-123",
            "authorized",
            payment={
                "id": "mp-payment-789",
                "status": "processed",
                "date_created": "2026-10-08T22:00:00-03:00",
            },
        )
        with patch.dict(os.environ, {
            "MERCADOPAGO_ACCESS_TOKEN": "TEST-token",
            "MERCADOPAGO_WEBHOOK_SECRET": "webhook-test-secret",
            "B7_PUBLIC_URL": "https://b7-test.example",
        }), patch("server.mercadopago_api_request") as provider_request:
            status, response = self.request("/api/subscriptions", {"plan": "corte"})
        self.assertEqual(status, 400)
        self.assertIn("assinatura ativa", response["error"])
        provider_request.assert_not_called()

    def test_membership_requires_a_current_processed_invoice(self):
        result, _, user = self.create_pending_subscription()
        with self.database.connect() as connection:
            external_reference = connection.execute(
                "SELECT external_reference FROM subscriptions WHERE user_id = ?", (user["id"],)
            ).fetchone()[0]
        self.database.update_subscription_from_provider(
            external_reference, "mp-subscription-123", "authorized"
        )
        self.assertFalse(self.database.get_subscription_for_user(user["id"])["active"])

        self.database.update_subscription_from_provider(
            external_reference,
            "mp-subscription-123",
            "authorized",
            payment={
                "id": "mp-payment-rejected",
                "status": "recycling",
                "date_created": "2026-10-08T22:00:00-03:00",
            },
        )
        self.assertFalse(self.database.get_subscription_for_user(user["id"])["active"])

        self.database.update_subscription_from_provider(
            external_reference,
            "mp-subscription-123",
            "authorized",
            payment={
                "id": "mp-payment-approved",
                "status": "processed",
                "date_created": "2026-10-08T22:05:00-03:00",
            },
        )
        membership = self.database.get_subscription_for_user(user["id"])
        self.assertTrue(membership["active"])
        self.assertEqual(membership["payment_status"], "processed")


if __name__ == "__main__":
    unittest.main()