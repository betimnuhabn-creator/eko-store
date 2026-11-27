<?php
/**
 * EKO Store – vetëm klientët e shumicës (të aprovuar) mund të blejnë në eko-store.com.
 *
 * Vendoset te: WordPress → Snippets → Add New (Code Snippets), "Run everywhere".
 *
 * - Vizitorët pa llogari: nuk shtojnë në shportë; shohin "Kyçuni për të porositur".
 * - Të regjistruarit pa aprovim (pa rolin "Wholesale Customer"): nuk shtojnë në shportë;
 *   shohin "Llogaria juaj pret aprovimin për shumicë".
 * - Wholesale Customer, Administrator dhe Shop Manager: blejnë normalisht.
 * - Aplikacioni EKO Store nuk preket (lidhja përdor çelësin e administratorit).
 */

if (!defined('ABSPATH')) exit;

function eko_can_buy() {
    if (!is_user_logged_in()) return false;
    $roles = (array) wp_get_current_user()->roles;
    return (bool) array_intersect($roles, array('wholesale_customer', 'administrator', 'shop_manager'));
}

// 1. Produktet dhe madhësitë nuk blihen nga të tjerët (butoni "Shto në shportë" zhduket).
add_filter('woocommerce_is_purchasable', function ($ok) {
    return eko_can_buy() ? $ok : false;
}, 99);
add_filter('woocommerce_variation_is_purchasable', function ($ok) {
    return eko_can_buy() ? $ok : false;
}, 99);

// 2. Edhe nëse dikush e provon me link direkt (?add-to-cart=...), refuzohet.
add_filter('woocommerce_add_to_cart_validation', function ($ok) {
    if (eko_can_buy()) return $ok;
    wc_add_notice(is_user_logged_in()
        ? 'Llogaria juaj pret aprovimin si klient shumice. Do t\'ju njoftojmë sapo të aprovohet.'
        : 'Ju lutem kyçuni me llogarinë e shumicës për të porositur.', 'error');
    return false;
}, 99);

// 3. Shporta / pagesa: produktet e mbetura nga më parë hiqen.
add_action('woocommerce_check_cart_items', function () {
    if (eko_can_buy() || !WC()->cart || WC()->cart->is_empty()) return;
    WC()->cart->empty_cart();
    wc_add_notice('Porositë janë vetëm për klientët e shumicës të aprovuar.', 'error');
});

// 4. Mesazhi në vend të butonit (faqja e produktit dhe lista e produkteve).
function eko_buy_notice() {
    if (eko_can_buy()) return;
    if (is_user_logged_in()) {
        echo '<p class="eko-buy-note">Llogaria juaj pret aprovimin si klient shumice.</p>';
    } else {
        $url = esc_url(wc_get_page_permalink('myaccount'));
        echo '<p class="eko-buy-note"><a href="' . $url . '">Kyçuni</a> ose regjistrohuni për të porositur.</p>';
    }
}
add_action('woocommerce_single_product_summary', 'eko_buy_notice', 31);
add_action('woocommerce_after_shop_loop_item', 'eko_buy_notice', 11);
