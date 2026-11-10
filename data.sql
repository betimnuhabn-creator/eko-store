SET session_replication_role = replica;

--
-- PostgreSQL database dump
--

-- \restrict aTuzS3S7Ne5sQKwSoCRcomaygBQSnQRomeMhc8KlicbbaEGbHhgqKMlpg2fXxsc

-- Dumped from database version 17.11
-- Dumped by pg_dump version 17.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: audit_log_entries; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

COPY "auth"."audit_log_entries" ("instance_id", "id", "payload", "created_at", "ip_address") FROM stdin;
\.


--
-- Data for Name: custom_oauth_providers; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

COPY "auth"."custom_oauth_providers" ("id", "provider_type", "identifier", "name", "client_id", "client_secret", "acceptable_client_ids", "scopes", "pkce_enabled", "attribute_mapping", "authorization_params", "enabled", "email_optional", "issuer", "discovery_url", "skip_nonce_check", "cached_discovery", "discovery_cached_at", "authorization_url", "token_url", "userinfo_url", "jwks_uri", "created_at", "updated_at", "custom_claims_allowlist") FROM stdin;
\.


--
-- Data for Name: flow_state; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

COPY "auth"."flow_state" ("id", "user_id", "auth_code", "code_challenge_method", "code_challenge", "provider_type", "provider_access_token", "provider_refresh_token", "created_at", "updated_at", "authentication_method", "auth_code_issued_at", "invite_token", "referrer", "oauth_client_state_id", "linking_target_id", "email_optional") FROM stdin;
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

COPY "auth"."users" ("instance_id", "id", "aud", "role", "email", "encrypted_password", "email_confirmed_at", "invited_at", "confirmation_token", "confirmation_sent_at", "recovery_token", "recovery_sent_at", "email_change_token_new", "email_change", "email_change_sent_at", "last_sign_in_at", "raw_app_meta_data", "raw_user_meta_data", "is_super_admin", "created_at", "updated_at", "phone", "phone_confirmed_at", "phone_change", "phone_change_token", "phone_change_sent_at", "email_change_token_current", "email_change_confirm_status", "banned_until", "reauthentication_token", "reauthentication_sent_at", "is_sso_user", "deleted_at", "is_anonymous") FROM stdin;
\N	00000000-0000-0000-0000-000000000001	authenticated	authenticated	admin@x.com	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	{"full_name": "Admin"}	\N	\N	\N	\N	\N			\N		0	\N		\N	f	\N	f
\N	00000000-0000-0000-0000-000000000002	authenticated	authenticated	klient@x.com	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	{"full_name": "Klient"}	\N	\N	\N	\N	\N			\N		0	\N		\N	f	\N	f
\N	00000000-0000-0000-0000-000000000003	authenticated	authenticated	firma@x.com	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	{"full_name": "Firma"}	\N	\N	\N	\N	\N			\N		0	\N		\N	f	\N	f
\.


--
-- Data for Name: identities; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

COPY "auth"."identities" ("provider_id", "user_id", "identity_data", "provider", "last_sign_in_at", "created_at", "updated_at", "id") FROM stdin;
\.


--
-- Data for Name: instances; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

COPY "auth"."instances" ("id", "uuid", "raw_base_config", "created_at", "updated_at") FROM stdin;
\.


--
-- Data for Name: oauth_clients; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

COPY "auth"."oauth_clients" ("id", "client_secret_hash", "registration_type", "redirect_uris", "grant_types", "client_name", "client_uri", "logo_uri", "created_at", "updated_at", "deleted_at", "client_type", "token_endpoint_auth_method") FROM stdin;
\.


--
-- Data for Name: sessions; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

COPY "auth"."sessions" ("id", "user_id", "created_at", "updated_at", "factor_id", "aal", "not_after", "refreshed_at", "user_agent", "ip", "tag", "oauth_client_id", "refresh_token_hmac_key", "refresh_token_counter", "scopes") FROM stdin;
\.


--
-- Data for Name: mfa_amr_claims; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

COPY "auth"."mfa_amr_claims" ("session_id", "created_at", "updated_at", "authentication_method", "id") FROM stdin;
\.


--
-- Data for Name: mfa_factors; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

COPY "auth"."mfa_factors" ("id", "user_id", "friendly_name", "factor_type", "status", "created_at", "updated_at", "secret", "phone", "last_challenged_at", "web_authn_credential", "web_authn_aaguid", "last_webauthn_challenge_data") FROM stdin;
\.


--
-- Data for Name: mfa_challenges; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

COPY "auth"."mfa_challenges" ("id", "factor_id", "created_at", "verified_at", "ip_address", "otp_code", "web_authn_session_data") FROM stdin;
\.


--
-- Data for Name: mfa_recovery_code_sets; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

COPY "auth"."mfa_recovery_code_sets" ("id", "user_id", "mfa_factor_id", "failed_verification_count", "verification_locked_until", "created_at", "updated_at") FROM stdin;
\.


--
-- Data for Name: mfa_recovery_codes; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

COPY "auth"."mfa_recovery_codes" ("id", "mfa_recovery_code_set_id", "code_hash", "consumed_at", "created_at") FROM stdin;
\.


--
-- Data for Name: oauth_authorizations; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

COPY "auth"."oauth_authorizations" ("id", "authorization_id", "client_id", "user_id", "redirect_uri", "scope", "state", "resource", "code_challenge", "code_challenge_method", "response_type", "status", "authorization_code", "created_at", "expires_at", "approved_at", "nonce") FROM stdin;
\.


--
-- Data for Name: oauth_client_states; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

COPY "auth"."oauth_client_states" ("id", "provider_type", "code_verifier", "created_at") FROM stdin;
\.


--
-- Data for Name: oauth_consents; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

COPY "auth"."oauth_consents" ("id", "user_id", "client_id", "scopes", "granted_at", "revoked_at") FROM stdin;
\.


--
-- Data for Name: one_time_tokens; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

COPY "auth"."one_time_tokens" ("id", "user_id", "token_type", "token_hash", "relates_to", "created_at", "updated_at", "expires_at") FROM stdin;
\.


--
-- Data for Name: refresh_tokens; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

COPY "auth"."refresh_tokens" ("instance_id", "id", "token", "user_id", "revoked", "created_at", "updated_at", "parent", "session_id") FROM stdin;
\.


--
-- Data for Name: sso_providers; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

COPY "auth"."sso_providers" ("id", "resource_id", "created_at", "updated_at", "disabled") FROM stdin;
\.


--
-- Data for Name: saml_providers; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

COPY "auth"."saml_providers" ("id", "sso_provider_id", "entity_id", "metadata_xml", "metadata_url", "attribute_mapping", "created_at", "updated_at", "name_id_format") FROM stdin;
\.


--
-- Data for Name: saml_relay_states; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

COPY "auth"."saml_relay_states" ("id", "sso_provider_id", "request_id", "for_email", "redirect_to", "created_at", "updated_at", "flow_state_id") FROM stdin;
\.


--
-- Data for Name: scim_tokens; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

COPY "auth"."scim_tokens" ("id", "sso_provider_id", "token_hash", "prefix", "created_at", "expires_at", "revoked_at", "last_used_at") FROM stdin;
\.


--
-- Data for Name: scim_users; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

COPY "auth"."scim_users" ("id", "sso_provider_id", "user_id", "resource", "created_at", "updated_at", "deleted_at") FROM stdin;
\.


--
-- Data for Name: sso_domains; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

COPY "auth"."sso_domains" ("id", "sso_provider_id", "domain", "created_at", "updated_at") FROM stdin;
\.


--
-- Data for Name: webauthn_challenges; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

COPY "auth"."webauthn_challenges" ("id", "user_id", "challenge_type", "session_data", "created_at", "expires_at") FROM stdin;
\.


--
-- Data for Name: webauthn_credentials; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

COPY "auth"."webauthn_credentials" ("id", "user_id", "credential_id", "public_key", "attestation_type", "aaguid", "sign_count", "transports", "backup_eligible", "backed_up", "friendly_name", "created_at", "updated_at", "last_used_at") FROM stdin;
\.


--
-- Data for Name: categories; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY "public"."categories" ("id", "name_sq", "name_en", "sort_order", "active", "created_at") FROM stdin;
42be5a92-7743-484e-9538-85782d72a6c0	Hidrosanitari	Plumbing	10	t	2026-11-10 21:35:43.580326+00
75454a40-796d-4446-a963-4a79cba6570b	Ngrohje	Heating	20	t	2026-11-10 21:35:43.580326+00
c1c11a00-6884-4a38-8f10-ace9b635a7e5	Pajisje banjoje	Bathroom fittings	30	t	2026-11-10 21:35:43.580326+00
\.


--
-- Data for Name: offers; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY "public"."offers" ("id", "title_sq", "title_en", "description_sq", "description_en", "starts_at", "ends_at", "active", "cancelled_at", "activation_notified_at", "created_by", "created_at", "updated_at") FROM stdin;
\.


--
-- Data for Name: products; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY "public"."products" ("id", "sku", "name", "description", "retail_price", "wholesale_price", "stock", "active", "created_at", "name_en", "description_en", "category_id", "unit", "images", "updated_at", "announced_at") FROM stdin;
5b1eb983-5140-4de1-bc12-ca863f489744	HS-003	Valvul topi 1/2"	Valvul topi prej bronzi.	4.80	3.30	150	t	2026-11-10 21:35:43.865287+00	Ball valve 1/2"	Brass ball valve.	42be5a92-7743-484e-9538-85782d72a6c0	copë	{}	2026-11-10 21:35:43.865287+00	2026-11-10 21:35:43.865287+00
b43a2c7a-ab45-40ce-a84b-c9c6fee38695	HS-002	Tub PPR 20mm	Tub PPR për ujë të ngrohtë dhe të ftohtë, 4 m.	3.20	2.10	400	t	2026-11-10 21:35:43.865287+00	PPR pipe 20mm	PPR pipe for hot and cold water, 4 m.	42be5a92-7743-484e-9538-85782d72a6c0	copë	{}	2026-11-10 21:35:43.865287+00	2026-11-10 21:35:43.865287+00
1a8bf113-a67a-4774-9285-a10ca9438be2	NG-001	Radiator alumini 600	Element radiatori alumini, lartësia 600 mm.	11.50	8.90	0	t	2026-11-10 21:35:43.865287+00	Aluminium radiator 600	Aluminium radiator section, 600 mm high.	75454a40-796d-4446-a963-4a79cba6570b	copë	{}	2026-11-10 21:35:43.865287+00	2026-11-10 21:35:43.865287+00
0a36afef-1a6f-4ea4-a4e8-3ce18a2371fd	HS-001	Rubinet lavamani krom	Rubinet me një levë, krom.	34.90	26.50	12	t	2026-11-10 21:35:43.865287+00	Chrome basin tap	Single-lever basin tap, chrome.	c1c11a00-6884-4a38-8f10-ace9b635a7e5	copë	{}	2026-11-10 21:35:43.865287+00	2026-11-10 21:35:43.865287+00
\.


--
-- Data for Name: profiles; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY "public"."profiles" ("id", "full_name", "phone", "role", "created_at", "email", "business_name", "business_number", "address", "city", "language", "updated_at", "wholesale_status", "promo_new_products", "promo_offers", "promo_price_changes", "promo_tester") FROM stdin;
00000000-0000-0000-0000-000000000002	Klient		retail	2026-11-10 21:35:58.40923+00	klient@x.com					sq	2026-11-10 21:35:58.40923+00	none	f	f	f	f
00000000-0000-0000-0000-000000000001	Admin		admin	2026-11-10 21:35:58.40923+00	admin@x.com					sq	2026-11-10 21:35:58.40923+00	none	f	f	f	f
00000000-0000-0000-0000-000000000003	Firma		retail	2026-11-10 21:35:58.40923+00	firma@x.com					sq	2026-11-10 21:35:58.40923+00	approved	f	f	f	f
\.


--
-- Data for Name: promo_events; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY "public"."promo_events" ("id", "kind", "product_id", "offer_id", "data", "status", "recipients", "dedupe_key", "created_at", "updated_at", "processed_at", "error") FROM stdin;
824629cd-2a94-4413-9a13-e337b56a6697	new_product	5b1eb983-5140-4de1-bc12-ca863f489744	\N	{}	pending	\N	new_product:5b1eb983-5140-4de1-bc12-ca863f489744	2026-11-10 21:35:43.865287+00	2026-11-10 21:35:43.865287+00	\N	\N
4debc6cd-4d06-492b-9bb1-ce20ffa5d3ee	new_product	b43a2c7a-ab45-40ce-a84b-c9c6fee38695	\N	{}	pending	\N	new_product:b43a2c7a-ab45-40ce-a84b-c9c6fee38695	2026-11-10 21:35:43.865287+00	2026-11-10 21:35:43.865287+00	\N	\N
f84e193d-fc7b-4ead-86ba-c773532b8ca8	new_product	1a8bf113-a67a-4774-9285-a10ca9438be2	\N	{}	pending	\N	new_product:1a8bf113-a67a-4774-9285-a10ca9438be2	2026-11-10 21:35:43.865287+00	2026-11-10 21:35:43.865287+00	\N	\N
d1ebb72d-df93-4016-928f-22b67da57174	new_product	0a36afef-1a6f-4ea4-a4e8-3ce18a2371fd	\N	{}	pending	\N	new_product:0a36afef-1a6f-4ea4-a4e8-3ce18a2371fd	2026-11-10 21:35:43.865287+00	2026-11-10 21:35:43.865287+00	\N	\N
\.


--
-- Data for Name: notifications; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY "public"."notifications" ("id", "recipient_id", "type", "data", "read_at", "dispatched_at", "created_at", "claimed_at", "claim_token", "attempts", "last_error", "category", "event_id") FROM stdin;
b05857d8-e28d-4067-866a-35a75047d404	00000000-0000-0000-0000-000000000002	order_status	{"status": "confirmed", "order_number": 1}	\N	\N	2026-11-10 21:35:58.40923+00	\N	\N	0	\N	order	\N
\.


--
-- Data for Name: offer_items; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY "public"."offer_items" ("offer_id", "product_id", "offer_price", "offer_wholesale_price") FROM stdin;
\.


--
-- Data for Name: orders; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY "public"."orders" ("id", "customer_id", "status", "total", "created_at", "price_tier", "item_count", "payment_method", "delivery_name", "delivery_phone", "delivery_address", "delivery_city", "customer_note", "admin_note", "updated_at", "order_number", "archived_at", "archived_by") FROM stdin;
d265d6ba-14b6-48a6-a1ff-587848620381	00000000-0000-0000-0000-000000000002	new	100.00	2026-11-10 21:35:58.40923+00	retail	1	cash_on_delivery	K	1	A	C			2026-11-10 21:35:58.40923+00	1001	\N	\N
c1d57bb8-dbc9-4775-ab32-3ef019f2d48d	00000000-0000-0000-0000-000000000003	cancelled	70.00	2026-11-10 21:35:58.40923+00	retail	1	cash_on_delivery	F	1	A	C			2026-11-10 21:35:58.40923+00	1002	2026-11-10 21:35:58.40923+00	00000000-0000-0000-0000-000000000001
\.


--
-- Data for Name: order_items; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY "public"."order_items" ("id", "order_id", "product_id", "quantity", "unit_price", "product_name", "sku", "unit", "offer_id") FROM stdin;
939e7a89-fe10-454e-b1c6-33f5f3baec2d	d265d6ba-14b6-48a6-a1ff-587848620381	5b1eb983-5140-4de1-bc12-ca863f489744	1	100.00	Valvul topi 1/2"	HS-003	copë	\N
f7e1a6ae-45c5-4cfe-b3e3-a547eb1d517b	c1d57bb8-dbc9-4775-ab32-3ef019f2d48d	5b1eb983-5140-4de1-bc12-ca863f489744	1	70.00	Valvul topi 1/2"	HS-003	copë	\N
\.


--
-- Data for Name: promo_settings; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY "public"."promo_settings" ("id", "enabled", "test_only", "daily_cap", "debounce_minutes", "functions_url", "dispatch_request_id", "updated_at") FROM stdin;
t	f	t	3	5		\N	2026-11-10 21:35:43.739079+00
\.


--
-- Data for Name: push_tokens; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY "public"."push_tokens" ("token", "user_id", "platform", "updated_at") FROM stdin;
\.


--
-- Data for Name: buckets; Type: TABLE DATA; Schema: storage; Owner: supabase_storage_admin
--

COPY "storage"."buckets" ("id", "name", "owner", "created_at", "updated_at", "public", "avif_autodetection", "file_size_limit", "allowed_mime_types", "owner_id", "type", "versioning_status", "lifecycle_configuration", "lifecycle_configuration_generation") FROM stdin;
product-images	product-images	\N	2026-11-10 21:35:43.580326+00	2026-11-10 21:35:43.580326+00	t	f	5242880	{image/jpeg,image/png,image/webp}	\N	STANDARD	DISABLED	\N	\N
\.


--
-- Data for Name: buckets_analytics; Type: TABLE DATA; Schema: storage; Owner: supabase_storage_admin
--

COPY "storage"."buckets_analytics" ("name", "type", "format", "created_at", "updated_at", "id", "deleted_at") FROM stdin;
\.


--
-- Data for Name: buckets_vectors; Type: TABLE DATA; Schema: storage; Owner: supabase_storage_admin
--

COPY "storage"."buckets_vectors" ("id", "type", "created_at", "updated_at") FROM stdin;
\.


--
-- Data for Name: iceberg_namespaces; Type: TABLE DATA; Schema: storage; Owner: supabase_storage_admin
--

COPY "storage"."iceberg_namespaces" ("id", "bucket_name", "name", "created_at", "updated_at", "metadata", "catalog_id") FROM stdin;
\.


--
-- Data for Name: iceberg_tables; Type: TABLE DATA; Schema: storage; Owner: supabase_storage_admin
--

COPY "storage"."iceberg_tables" ("id", "namespace_id", "bucket_name", "name", "location", "created_at", "updated_at", "remote_table_id", "shard_key", "shard_id", "catalog_id") FROM stdin;
\.


--
-- Data for Name: objects; Type: TABLE DATA; Schema: storage; Owner: supabase_storage_admin
--

COPY "storage"."objects" ("id", "bucket_id", "name", "owner", "created_at", "updated_at", "last_accessed_at", "metadata", "version", "owner_id", "user_metadata", "archived_at", "is_delete_marker", "is_versioned") FROM stdin;
\.


--
-- Data for Name: s3_multipart_uploads; Type: TABLE DATA; Schema: storage; Owner: supabase_storage_admin
--

COPY "storage"."s3_multipart_uploads" ("id", "in_progress_size", "upload_signature", "bucket_id", "key", "version", "owner_id", "created_at", "user_metadata", "metadata") FROM stdin;
\.


--
-- Data for Name: s3_multipart_uploads_parts; Type: TABLE DATA; Schema: storage; Owner: supabase_storage_admin
--

COPY "storage"."s3_multipart_uploads_parts" ("id", "upload_id", "size", "part_number", "bucket_id", "key", "etag", "owner_id", "version", "created_at") FROM stdin;
\.


--
-- Data for Name: vector_indexes; Type: TABLE DATA; Schema: storage; Owner: supabase_storage_admin
--

COPY "storage"."vector_indexes" ("id", "name", "bucket_id", "data_type", "dimension", "distance_metric", "metadata_configuration", "created_at", "updated_at") FROM stdin;
\.


--
-- Data for Name: hooks; Type: TABLE DATA; Schema: supabase_functions; Owner: supabase_functions_admin
--

COPY "supabase_functions"."hooks" ("id", "hook_table_id", "hook_name", "created_at", "request_id") FROM stdin;
\.


--
-- Name: refresh_tokens_id_seq; Type: SEQUENCE SET; Schema: auth; Owner: supabase_auth_admin
--

SELECT pg_catalog.setval('"auth"."refresh_tokens_id_seq"', 1, false);


--
-- Name: orders_order_number_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('"public"."orders_order_number_seq"', 1002, true);


--
-- Name: hooks_id_seq; Type: SEQUENCE SET; Schema: supabase_functions; Owner: supabase_functions_admin
--

SELECT pg_catalog.setval('"supabase_functions"."hooks_id_seq"', 1, false);


--
-- PostgreSQL database dump complete
--

-- \unrestrict aTuzS3S7Ne5sQKwSoCRcomaygBQSnQRomeMhc8KlicbbaEGbHhgqKMlpg2fXxsc

RESET ALL;
