// EKO Store – one account for eko-store.com and the EKO Store app.
// Add as a PHP snippet (Snippets → Add New → Run everywhere). The "<?php" line is added by the plugin.
//
// 1. Login on the website fails → the app is asked (Supabase Edge Function "account-link").
//    Right app password → the WordPress user is created, or its password set to this one.
// 2. /wp-json/eko/v1/verify  – the app asks the website to check a password (secret header only).
// 3. /wp-json/eko/v1/role    – wholesale approved/revoked in the app → role "Wholesale Customer".
// 4. Role "Wholesale Customer" given/removed here → approved/revoked in the app.
// Administrators / shop managers are never linked or changed. Passwords are never stored in plain text or logged.

// ▼▼ The same long random value as EKO_LINK_SECRET in Supabase → Edge Functions → Secrets ▼▼
if ( ! defined( 'EKO_LINK_SECRET' ) ) {
	define( 'EKO_LINK_SECRET', 'VENDOSNI-KETU-SEKRETIN' );
}
if ( ! defined( 'EKO_LINK_URL' ) ) {
	define( 'EKO_LINK_URL', 'https://mfpmcriffqlhlgaptdzx.supabase.co/functions/v1/account-link' );
}

function eko_link_ready() {
	return strlen( EKO_LINK_SECRET ) >= 16 && 'VENDOSNI-KETU-SEKRETIN' !== EKO_LINK_SECRET;
}
function eko_link_secret_ok( $given ) {
	return eko_link_ready() && is_string( $given ) && hash_equals( EKO_LINK_SECRET, $given );
}
function eko_link_is_staff( $user ) {
	return $user && ( user_can( $user, 'manage_options' ) || user_can( $user, 'manage_woocommerce' ) );
}
function eko_link_call( $body, $blocking = true ) {
	return wp_remote_post( EKO_LINK_URL, array(
		'timeout'  => $blocking ? 10 : 3,
		'blocking' => $blocking,
		'headers'  => array( 'Content-Type' => 'application/json', 'X-EKO-Link' => EKO_LINK_SECRET ),
		'body'     => wp_json_encode( $body ),
	) );
}

// 1. Website login failed → ask the app.
add_filter( 'authenticate', function ( $user, $username, $password ) {
	if ( $user instanceof WP_User || ! eko_link_ready() || '' === (string) $username || '' === (string) $password ) {
		return $user;
	}
	$email = is_email( $username ) ? $username : '';
	if ( ! $email ) {
		$by_login = get_user_by( 'login', $username );
		$email    = $by_login ? $by_login->user_email : '';
	}
	if ( ! $email ) {
		return $user;
	}
	$existing = get_user_by( 'email', $email );
	if ( $existing && eko_link_is_staff( $existing ) ) {
		return $user;
	}
	$res = eko_link_call( array( 'action' => 'wp_login', 'email' => $email, 'password' => $password ) );
	if ( is_wp_error( $res ) || 200 !== (int) wp_remote_retrieve_response_code( $res ) ) {
		return $user;
	}
	$d = json_decode( wp_remote_retrieve_body( $res ), true );
	if ( empty( $d['ok'] ) ) {
		return $user;
	}
	$GLOBALS['eko_link_quiet'] = true;
	if ( $existing ) {
		wp_set_password( $password, $existing->ID );
		$id = $existing->ID;
	} else {
		$login = sanitize_user( strtolower( $email ), true );
		if ( username_exists( $login ) ) {
			$login .= '-' . wp_generate_password( 4, false );
		}
		$parts = preg_split( '/\s+/', trim( (string) ( $d['full_name'] ?? '' ) ), 2 );
		$id    = wp_insert_user( array(
			'user_login' => $login,
			'user_email' => $email,
			'user_pass'  => $password,
			'first_name' => $parts[0] ?? '',
			'last_name'  => $parts[1] ?? '',
			'role'       => 'customer',
		) );
		if ( is_wp_error( $id ) ) {
			$GLOBALS['eko_link_quiet'] = false;
			return $user;
		}
		if ( ! empty( $d['phone'] ) ) {
			update_user_meta( $id, 'billing_phone', sanitize_text_field( $d['phone'] ) );
		}
		if ( ! empty( $d['business_name'] ) ) {
			update_user_meta( $id, 'billing_company', sanitize_text_field( $d['business_name'] ) );
		}
	}
	$u = new WP_User( $id );
	if ( ! empty( $d['wholesale'] ) && ! in_array( 'wholesale_customer', (array) $u->roles, true ) ) {
		$u->set_role( 'wholesale_customer' );
	}
	$GLOBALS['eko_link_quiet'] = false;
	return get_user_by( 'id', $id );
}, 30, 3 );

// 2 + 3. Endpoints for the app (secret header only).
add_action( 'rest_api_init', function () {
	register_rest_route( 'eko/v1', '/verify', array(
		'methods'             => 'POST',
		'permission_callback' => '__return_true',
		'callback'            => function ( WP_REST_Request $r ) {
			if ( ! eko_link_secret_ok( $r->get_header( 'x-eko-link' ) ) ) {
				return new WP_REST_Response( array( 'ok' => false ), 401 );
			}
			$email    = sanitize_email( (string) $r->get_param( 'email' ) );
			$password = (string) $r->get_param( 'password' );
			$u        = $email ? get_user_by( 'email', $email ) : false;
			if ( ! $u || eko_link_is_staff( $u ) || '' === $password || ! wp_check_password( $password, $u->user_pass, $u->ID ) ) {
				return array( 'ok' => false );
			}
			$name = trim( $u->first_name . ' ' . $u->last_name );
			return array(
				'ok'            => true,
				'full_name'     => $name ? $name : $u->display_name,
				'phone'         => (string) get_user_meta( $u->ID, 'billing_phone', true ),
				'business_name' => (string) get_user_meta( $u->ID, 'billing_company', true ),
				'wholesale'     => in_array( 'wholesale_customer', (array) $u->roles, true ),
			);
		},
	) );
	register_rest_route( 'eko/v1', '/role', array(
		'methods'             => 'POST',
		'permission_callback' => '__return_true',
		'callback'            => function ( WP_REST_Request $r ) {
			if ( ! eko_link_secret_ok( $r->get_header( 'x-eko-link' ) ) ) {
				return new WP_REST_Response( array( 'ok' => false ), 401 );
			}
			$u = get_user_by( 'email', sanitize_email( (string) $r->get_param( 'email' ) ) );
			if ( ! $u || eko_link_is_staff( $u ) ) {
				return array( 'ok' => true, 'result' => 'no_website_account' );
			}
			$want = (bool) $r->get_param( 'wholesale' );
			$has  = in_array( 'wholesale_customer', (array) $u->roles, true );
			if ( $want !== $has ) {
				$GLOBALS['eko_link_quiet'] = true;
				$u->set_role( $want ? 'wholesale_customer' : 'customer' );
				$GLOBALS['eko_link_quiet'] = false;
			}
			return array( 'ok' => true, 'result' => $want === $has ? 'unchanged' : ( $want ? 'wholesale' : 'customer' ) );
		},
	) );
} );

// 4. Role changed here (Users → Change role to…) → tell the app.
add_action( 'set_user_role', function ( $user_id, $role, $old_roles ) {
	if ( ! empty( $GLOBALS['eko_link_quiet'] ) || ! eko_link_ready() ) {
		return;
	}
	$was = in_array( 'wholesale_customer', (array) $old_roles, true );
	$is  = ( 'wholesale_customer' === $role );
	if ( $was === $is ) {
		return;
	}
	$u = get_user_by( 'id', $user_id );
	if ( ! $u || eko_link_is_staff( $u ) ) {
		return;
	}
	eko_link_call( array( 'action' => 'wholesale', 'email' => $u->user_email, 'wholesale' => $is ) );
}, 10, 3 );
