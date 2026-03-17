# Pagar.me API v5 - Complete Integration Research

> Research conducted on 2026-03-17 from official Pagar.me documentation.
> Sources: docs.pagar.me, npmjs.com

---

## 1. Authentication

**Source:** https://docs.pagar.me/reference/autentica%C3%A7%C3%A3o-2

### Base URL
```
https://api.pagar.me/core/v5
```

### Method: HTTP Basic Authentication
- **Username:** Your Secret Key (sk_test_* for sandbox, sk_* for production)
- **Password:** Empty (leave blank)

### Headers
```
Authorization: Basic <base64(secret_key + ":")>
Content-Type: application/json
```

### Node.js Example
```javascript
const headers = {
  'Authorization': 'Basic ' + Buffer.from('sk_test_YourSecretKey:').toString('base64'),
  'Content-Type': 'application/json'
};
```

### Key Types
| Key | Prefix (Test) | Prefix (Production) | Usage |
|-----|---------------|---------------------|-------|
| Secret Key | `sk_test_*` | `sk_*` | Server-side API calls |
| Public Key | `pk_test_*` | `pk_*` | Client-side tokenization only |

**IMPORTANT:** Secret keys must NEVER be exposed client-side or shared with third parties.

---

## 2. Create Order (Payment)

**Source:** https://docs.pagar.me/reference/criar-pedido-2

### Endpoint
```
POST https://api.pagar.me/core/v5/orders
```

### Complete Request Body (Credit Card with card_id)
```json
{
  "items": [
    {
      "amount": 2990,
      "description": "Chaveiro do Tesseract",
      "quantity": 1,
      "code": "item_001"
    }
  ],
  "customer": {
    "name": "Tony Stark",
    "email": "tony.stark@example.com",
    "type": "individual",
    "document": "01234567890",
    "phones": {
      "home_phone": {
        "country_code": "55",
        "area_code": "21",
        "number": "22180513"
      },
      "mobile_phone": {
        "country_code": "55",
        "area_code": "21",
        "number": "987654321"
      }
    },
    "address": {
      "street": "R. Dr. Geraldo Campos Moreira",
      "number": "240",
      "complement": "Sala 1",
      "zip_code": "01451001",
      "neighborhood": "Cidade Moncoes",
      "city": "Sao Paulo",
      "state": "SP",
      "country": "BR"
    }
  },
  "payments": [
    {
      "payment_method": "credit_card",
      "credit_card": {
        "card_id": "card_xxxxx",
        "installments": 1,
        "statement_descriptor": "COMPANY NAME",
        "capture": true
      }
    }
  ]
}
```

### PIX Order Request
```json
{
  "items": [
    {
      "amount": 2990,
      "description": "Chaveiro do Tesseract",
      "quantity": 1
    }
  ],
  "customer": {
    "name": "Tony Stark",
    "email": "tony.stark@example.com",
    "type": "individual",
    "document": "01234567890",
    "phones": {
      "home_phone": {
        "country_code": "55",
        "number": "22180513",
        "area_code": "21"
      }
    }
  },
  "payments": [
    {
      "payment_method": "pix",
      "pix": {
        "expires_in": 3600,
        "additional_information": [
          {
            "name": "Quantidade",
            "value": "2"
          }
        ]
      }
    }
  ]
}
```

### PIX Response (relevant fields)
```json
{
  "id": "or_...",
  "status": "pending",
  "charges": [
    {
      "id": "ch_Qym35AmhvcZ5goJV",
      "status": "pending",
      "payment_method": "pix",
      "last_transaction": {
        "id": "tran_24zrDeoJf7FXLEp9",
        "qr_code": "00020101021226840014br.gov.bcb.pix...",
        "qr_code_url": "https://api.pagar.me/core/v1/transactions/tran_.../qrcode",
        "expires_at": "2023-10-22T04:43:47Z",
        "end_to_end_id": "E12345678912",
        "payer": {
          "name": "Tony Stark",
          "document": "***.777.888-**"
        }
      }
    }
  ]
}
```

### PIX Key Fields
| Field | Type | Description |
|-------|------|-------------|
| `expires_in` | integer | Expiration in SECONDS (mandatory) |
| `expires_at` | datetime | Expiration datetime (max 10 years) |
| `additional_information` | array | Key/value pairs shown to consumer |

### Webhook Response for order.paid (Credit Card)
```json
{
  "id": "hook_RyEKQO789TRpZjv5",
  "account": {
    "id": "acc_jZkdN857et650oNv",
    "name": "Lojinha"
  },
  "type": "order.paid",
  "created_at": "2017-06-29T20:23:47",
  "data": {
    "id": "or_ZdnB5BBCmYhk534R",
    "code": "1303724",
    "amount": 12356,
    "currency": "BRL",
    "closed": true,
    "items": [
      {
        "id": "oi_EqnMMrbFgBf0MaN1",
        "description": "Produto",
        "amount": 10166,
        "quantity": 1,
        "status": "active"
      }
    ],
    "customer": {
      "id": "cus_oy23JRQCM1cvzlmD",
      "name": "FABIO",
      "email": "customer@example.com",
      "document": "09006068709",
      "type": "individual",
      "delinquent": false,
      "phones": {}
    },
    "shipping": {
      "amount": 2190,
      "description": "Economico",
      "address": {
        "zip_code": "90265",
        "city": "Malibu",
        "state": "CA",
        "country": "US",
        "line_1": "10880, Malibu Point, Malibu Central"
      }
    },
    "status": "paid",
    "charges": [
      {
        "id": "ch_d22356Jf4WuGr8no",
        "code": "1303624",
        "gateway_id": "da7f2304-1937-42a4-b995-0f4ea2b36264",
        "amount": 12356,
        "status": "paid",
        "currency": "BRL",
        "payment_method": "credit_card",
        "paid_at": "2022-06-29T20:23:47",
        "customer": { "..." : "..." },
        "last_transaction": {
          "id": "tran_opAqDj2390S1lKQO",
          "transaction_type": "credit_card",
          "amount": 12356,
          "status": "captured",
          "success": true,
          "installments": 2,
          "acquirer_name": "redecard",
          "acquirer_tid": "247391236",
          "acquirer_nsu": "247391236",
          "acquirer_auth_code": "236689",
          "operation_type": "capture",
          "card": {
            "id": "card_BjKOmahgAf0D23lw",
            "last_four_digits": "4485",
            "brand": "Visa",
            "holder_name": "FABIO",
            "exp_month": 6,
            "exp_year": 2025,
            "status": "active",
            "billing_address": { "..." : "..." },
            "type": "credit"
          },
          "gateway_response": { "code": "200" }
        }
      }
    ]
  }
}
```

### All Order Endpoints
| Method | Path | Description |
|--------|------|-------------|
| POST | `/orders` | Create order |
| POST | `/orders/{id}/charges` | Add charge to order |
| POST | `/orders/multimeios` | Create multi-payment order |
| POST | `/orders/multicompradores` | Create multi-buyer order |
| GET | `/orders/{id}` | Get order |
| PATCH | `/orders/{id}` | Close an order |
| GET | `/orders` | List orders |

### Order Statuses
- `pending` - Awaiting payment
- `paid` - Payment confirmed
- `canceled` - Order canceled
- `failed` - Payment failed

### Amounts
All amounts are in **centavos** (cents). Example: R$ 29.90 = `2990`

### Important Notes
- An order ALWAYS generates at least one charge
- Use `card_id` or `card_token` - NEVER send raw card data from server
- For PSP customers, customer object with address and phone is MANDATORY
- If providing `customer_id`, the full customer object is not needed (but one is required)
- `closed: true` = order cannot be modified after creation

---

## 3. Split Payments

**Source:** https://docs.pagar.me/reference/split-1, https://docs.pagar.me/docs/pedidos-com-split

### How It Works
Split is added to the `payments` array alongside the payment method. The `split` array defines how the payment is distributed among recipients.

### Split Rule Structure
```json
{
  "payments": [
    {
      "payment_method": "credit_card",
      "credit_card": { "..." : "..." },
      "split": [
        {
          "amount": 50,
          "recipient_id": "rp_XXXXXXXXXXXXXXXX",
          "type": "percentage",
          "options": {
            "charge_processing_fee": true,
            "charge_remainder_fee": true,
            "liable": true
          }
        },
        {
          "amount": 50,
          "recipient_id": "rp_YYYYYYYYYYYYYYYY",
          "type": "percentage",
          "options": {
            "charge_processing_fee": false,
            "charge_remainder_fee": false,
            "liable": false
          }
        }
      ]
    }
  ]
}
```

### Split Fields
| Field | Type | Description |
|-------|------|-------------|
| `amount` | integer | Value (cents for flat, percentage for percentage type) |
| `type` | string | `"flat"` (fixed amount in cents) or `"percentage"` (0-100) |
| `recipient_id` | string | Recipient ID (format: `rp_XXXXXXXXXXXXXXXX`) |
| `options.liable` | boolean | Recipient assumes chargeback liability |
| `options.charge_processing_fee` | boolean | Recipient pays transaction processing fees |
| `options.charge_remainder_fee` | boolean | Recipient receives remaining receivables |

### Split Response
```json
{
  "split": [
    {
      "id": "sr_rqNglzXwF5fMQ2Rd",
      "type": "percentage",
      "amount": 50,
      "recipient": {
        "id": "rp_7YZXapnCAWcGrnaV",
        "name": "Recipient 1",
        "email": "recipient1@example.com",
        "document": "26224451990",
        "type": "individual",
        "status": "active"
      },
      "options": {
        "liable": true,
        "charge_processing_fee": true,
        "charge_remainder_fee": true
      }
    }
  ]
}
```

### Mixed Split Example (Flat + Percentage)
```json
"split": [
  {
    "amount": 500,
    "recipient_id": "rp_1",
    "type": "flat",
    "options": { "liable": true, "charge_processing_fee": true, "charge_remainder_fee": true }
  },
  {
    "amount": 4500,
    "recipient_id": "rp_2",
    "type": "percentage",
    "options": { "liable": false, "charge_processing_fee": false, "charge_remainder_fee": false }
  }
]
```

### Rules
- At least one recipient MUST be responsible for chargeback liability (`liable: true`)
- At least one recipient MUST cover processing fees (`charge_processing_fee: true`)
- At least one recipient MUST handle remainder fees (`charge_remainder_fee: true`)
- Split is available ONLY for PSP customers
- Recipients must be registered before creating split orders
- For split orders with fraud analysis, `billing_address` is MANDATORY

---

## 4. Recipients API

**Source:** https://docs.pagar.me/reference/criar-recebedor-1, https://docs.pagar.me/page/novas-regras-para-cria%C3%A7%C3%A3o-de-sellers-de-marketplace-c-v5

### Endpoint
```
POST https://api.pagar.me/core/v5/recipients
```

### NEW Contract (mandatory since Nov 30, 2024)
The `register_information` object is now REQUIRED per Circular 3.978/20 (anti-money laundering).

### Individual Recipient (Pessoa Fisica)
```json
{
  "code": "vendor_001",
  "register_information": {
    "name": "Recebedor Pessoa fisica",
    "email": "individual@example.com",
    "document": "26224451990",
    "type": "individual",
    "site_url": "https://sitedorecebedor.com.br",
    "mother_name": "Nome da mae",
    "birthdate": "1984-10-30T00:00:00",
    "monthly_income": 120000,
    "professional_occupation": "Vendedor",
    "address": {
      "street": "Av. General Justo",
      "complementary": "Bloco A",
      "street_number": "375",
      "neighborhood": "Centro",
      "city": "Rio de Janeiro",
      "state": "RJ",
      "zip_code": "20021130",
      "reference_point": "Ao lado da banca de jornal"
    },
    "phone_numbers": [
      {
        "ddd": "21",
        "number": "994647568",
        "type": "mobile"
      }
    ]
  },
  "transfer_settings": {
    "transfer_enabled": false,
    "transfer_interval": "Daily",
    "transfer_day": 0
  },
  "default_bank_account": {
    "holder_name": "Tony Stark",
    "holder_type": "individual",
    "holder_document": "26224451990",
    "bank": "341",
    "branch_number": "1234",
    "branch_check_digit": "6",
    "account_number": "12345",
    "account_check_digit": "6",
    "type": "checking"
  },
  "automatic_anticipation_settings": {
    "enabled": true,
    "type": "full",
    "volume_percentage": 50,
    "delay": null
  }
}
```

### Company Recipient (Pessoa Juridica)
```json
{
  "code": "vendor_002",
  "register_information": {
    "company_name": "Recebedor pessoa juridica",
    "trading_name": "Empresa LTDA",
    "email": "contact@company.com",
    "document": "77699131000133",
    "type": "corporation",
    "site_url": "http://www.site.com",
    "annual_revenue": 1000000,
    "corporation_type": "LTDA",
    "founding_date": "2010-10-30",
    "main_address": {
      "street": "Av. General Justo",
      "complementary": "Bloco A",
      "street_number": "375",
      "neighborhood": "Centro",
      "city": "Rio de Janeiro",
      "state": "RJ",
      "zip_code": "20021130",
      "reference_point": "Ao lado da banca de jornal"
    },
    "phone_numbers": [
      {
        "ddd": "21",
        "number": "994647568",
        "type": "mobile"
      }
    ],
    "managing_partners": [
      {
        "name": "Tony Stark",
        "email": "tony@company.com",
        "document": "26224451990",
        "type": "individual",
        "mother_name": "Nome da mae",
        "birthdate": "1984-10-30T00:00:00",
        "monthly_income": 120000,
        "professional_occupation": "Vendedor",
        "self_declared_legal_representative": true,
        "address": {
          "street": "Av. General Justo",
          "complementary": "Bloco A",
          "street_number": "375",
          "neighborhood": "Centro",
          "city": "Rio de Janeiro",
          "state": "RJ",
          "zip_code": "20021130",
          "reference_point": "Ao lado da banca de jornal"
        },
        "phone_numbers": [
          {
            "ddd": "27",
            "number": "999992628",
            "type": "mobile"
          }
        ]
      }
    ]
  },
  "transfer_settings": {
    "transfer_enabled": false,
    "transfer_interval": "Daily",
    "transfer_day": 0
  },
  "default_bank_account": {
    "holder_name": "Tony Stark",
    "holder_type": "individual",
    "holder_document": "26224451990",
    "bank": "341",
    "branch_number": "1234",
    "branch_check_digit": "6",
    "account_number": "12345",
    "account_check_digit": "6",
    "type": "checking"
  },
  "automatic_anticipation_settings": {
    "enabled": true,
    "type": "full",
    "volume_percentage": 50,
    "delay": null
  }
}
```

### Required Fields - Individual
| Field | Required |
|-------|----------|
| `register_information.name` | Yes |
| `register_information.email` | Yes |
| `register_information.document` (CPF) | Yes |
| `register_information.type` = "individual" | Yes |
| `register_information.birthdate` | Yes |
| `register_information.monthly_income` | Yes |
| `register_information.professional_occupation` | Yes |
| `register_information.address.*` | Yes |
| `register_information.phone_numbers` | Yes (array) |
| `register_information.mother_name` | Optional |
| `register_information.site_url` | Optional |

### Required Fields - Corporation
| Field | Required |
|-------|----------|
| `register_information.company_name` | Yes |
| `register_information.trading_name` | Yes |
| `register_information.email` | Yes |
| `register_information.document` (CNPJ) | Yes |
| `register_information.type` = "corporation" | Yes |
| `register_information.annual_revenue` | Yes |
| `register_information.main_address.*` | Yes |
| `register_information.phone_numbers` | Yes (array) |
| `register_information.managing_partners` | Yes (at least 1) |
| `register_information.corporation_type` | Optional |
| `register_information.founding_date` | Optional |

### Bank Account Types
- `checking` - Conta corrente
- `savings` - Conta poupanca

### Transfer Interval Options
- `Daily` - Daily transfers
- `Weekly` - Weekly transfers
- `Monthly` - Monthly transfers

### Other Recipient Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | `/recipients/{recipient_id}` | Get recipient |
| PUT | `/recipients/{recipient_id}` | Update recipient |
| GET | `/recipients` | List recipients |
| PATCH | `/recipients/{recipient_id}/default-bank-account` | Update bank account |

---

## 5. Customers API

**Source:** https://docs.pagar.me/reference/criar-cliente-1

### Create Customer
```
POST https://api.pagar.me/core/v5/customers
```

### Request Body
```json
{
  "name": "Tony Stark",
  "email": "tony.stark@example.com",
  "type": "individual",
  "document": "01234567890",
  "document_type": "CPF",
  "phones": {
    "home_phone": {
      "country_code": "55",
      "area_code": "21",
      "number": "22180513"
    },
    "mobile_phone": {
      "country_code": "55",
      "area_code": "21",
      "number": "987654321"
    }
  },
  "address": {
    "street": "Av. General Justo",
    "number": "375",
    "complement": "Bloco A",
    "zip_code": "20021130",
    "neighborhood": "Centro",
    "city": "Rio de Janeiro",
    "state": "RJ",
    "country": "BR"
  }
}
```

### Important Notes
- **Email is unique**: If you create a customer with an existing email, it UPDATES the existing customer instead of creating a new one
- For PSP customers, all customer fields (including address and phone) are mandatory when creating orders
- You can use `customer_id` in orders instead of the full customer object

### Get Customer
```
GET https://api.pagar.me/core/v5/customers/{customer_id}
```

---

## 6. Card Tokenization

**Source:** https://docs.pagar.me/reference/criar-token-cart%C3%A3o-1

### Endpoint
```
POST https://api.pagar.me/core/v5/tokens?appId={public_key}
```

### Authentication
This endpoint uses the **PUBLIC KEY** (not secret key) passed as `appId` query parameter. Only `Content-Type` header is allowed.

### Request Body
```json
{
  "type": "card",
  "card": {
    "number": "4556366941062122",
    "holder_name": "Aardvark da Silva",
    "exp_month": 12,
    "exp_year": 2030,
    "cvv": "111"
  }
}
```

### Response
Returns a token object (e.g., `token_XXXXXXXX`) that can be used as `card_token` when creating orders.

### Notes
- Billing address is NOT tokenized - must be sent separately when creating orders
- Use `card_token` for first-time cards, `card_id` for saved cards
- Only Gateway customers can use `card_token`; PSP customers should use `card_id`

### Client-Side Tokenization (tokenizecard.js)
```html
<script src="https://checkout.pagar.me/v1/tokenizecard.js"
        data-pagarmecheckout-app-id="{{your_public_key}}">
</script>
```
- Domain must be registered in Pagar.me dashboard
- Token returned as `pagarmetoken` POST parameter

---

## 7. Webhooks

**Source:** https://docs.pagar.me/docs/webhooks, https://docs.pagar.me/reference/eventos-de-webhook-1

### Webhook Management Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | `/hooks` | List webhooks |
| GET | `/hooks/{hook_id}` | Get webhook |
| POST | `/hooks/{hook_id}/retry` | Resend failed webhook |

### Webhook Configuration
Webhooks are configured via the Pagar.me dashboard or API. You choose which events to listen to and the target URL.

### Port Requirements
- HTTP: port 80
- HTTPS: port 443

### Webhook Payload Structure
```json
{
  "id": "hook_RyEKQO789TRpZjv5",
  "account": {
    "id": "acc_jZkdN857et650oNv",
    "name": "Lojinha"
  },
  "type": "order.paid",
  "created_at": "2017-06-29T20:23:47",
  "data": {
    "id": "or_ZdnB5BBCmYhk534R",
    "code": "1303724",
    "amount": 12356,
    "currency": "BRL",
    "status": "paid",
    "items": [ "..." ],
    "customer": { "..." },
    "charges": [ "..." ]
  }
}
```

### Complete Event Types List

**Order Events:**
- `order.created` - Order created
- `order.paid` - Order paid
- `order.payment_failed` - Payment failed
- `order.canceled` - Order canceled
- `order.closed` - Order closed
- `order.updated` - Order updated

**Charge Events:**
- `charge.created` - Charge created
- `charge.updated` - Charge updated
- `charge.paid` - Charge paid
- `charge.payment_failed` - Charge payment failed
- `charge.refunded` - Charge refunded
- `charge.pending` - Charge pending
- `charge.processing` - Charge processing
- `charge.underpaid` - Charge underpaid
- `charge.overpaid` - Charge overpaid
- `charge.partial_canceled` - Partially canceled
- `charge.chargedback` - Chargebacked

**Antifraud Events:**
- `charge.antifraud_approved` - Approved by antifraud
- `charge.antifraud_reproved` - Rejected by antifraud
- `charge.antifraud_manual` - Manual review needed
- `charge.antifraud_pending` - Awaiting antifraud

**Customer Events:**
- `customer.created` - Customer created
- `customer.updated` - Customer updated

**Card Events:**
- `card.created`, `card.updated`, `card.deleted`, `card.expired`

**Recipient Events:**
- `recipient.created` - Recipient created
- `recipient.updated` - Recipient updated
- `recipient.deleted` - Recipient deleted

**Transfer Events:**
- `transfer.pending`, `transfer.created`, `transfer.processing`
- `transfer.paid`, `transfer.canceled`, `transfer.failed`

**Invoice Events:**
- `invoice.created`, `invoice.updated`, `invoice.paid`
- `invoice.payment_failed`, `invoice.canceled`

**Subscription Events:**
- `subscription.created`, `subscription.canceled`

**Bank Account Events:**
- `bank_account.created`, `bank_account.updated`, `bank_account.deleted`

**Checkout Events:**
- `checkout.created`, `checkout.canceled`, `checkout.closed`

**Other Events:**
- `address.created`, `address.updated`, `address.deleted`
- `plan.created`, `plan.updated`, `plan.deleted`
- `seller.created`, `seller.updated`, `seller.deleted`

---

## 8. Checkout (Hosted Payment Page)

**Source:** https://docs.pagar.me/docs/checkout

### YES - Pagar.me has a hosted checkout page

The checkout is hosted on Pagar.me's servers with full security standards.

### Integration Methods
1. **Redirect** - Redirect customer to checkout URL
2. **Lightbox** - Embed as modal within your site
3. **API-Driven** - Generate checkout URLs via API

### Customization
- Add your company logo
- Customize colors to match brand identity

### Payment Link API
```
POST https://api.pagar.me/core/v5/paymentlinks
```

Test environment: `https://sdx-api.pagar.me/core/v5/paymentlinks`

### Payment Link Endpoints
| Method | Path | Description |
|--------|------|-------------|
| POST | `/paymentlinks` | Create payment link |
| GET | `/paymentlinks/{id}` | Get payment link |
| GET | `/paymentlinks` | List payment links |
| PATCH | `/paymentlinks/{id}` | Activate/cancel link |

### Limitations
- Split in payment links works ONLY with `credit_card` payment method
- Subscription-type links cannot use installments or split
- Plan must be created before subscription link

---

## 9. Payment Methods Summary

**Source:** https://docs.pagar.me/docs/meios-de-pagamento

### Supported Methods
1. **Credit Card** (`credit_card`) - Standard credit card with installments, capture, 3DS
2. **Debit Card** (`debit_card`) - Direct debit
3. **PIX** (`pix`) - Instant Brazilian payment
4. **Boleto** (`boleto`) - Bank slip
5. **Voucher** (`voucher`) - Benefit cards (VR, Sodexo, Ticket)
6. **Private Label** - Exclusive merchant cards
7. **SafetyPay** - Bank transfer
8. **Google Pay** - Digital wallet
9. **Cash** - Custom payment tracking

### Credit Card Capabilities
- Charges, pre-authorization, partial capture, partial/full refunds
- Split, fraud prevention, 3DS
- Recurring payment flags, international currency

### PIX Capabilities
- Charges, full/partial refunds, split
- Refund limit: 90 days from settlement

---

## 10. Test Card Numbers (Simulator)

**Source:** https://docs.pagar.me/docs/simulador-de-cart%C3%A3o-de-cr%C3%A9dito

| Card Number | Scenario |
|-------------|----------|
| `4000000000000010` | Success - Paid |
| `4000000000000028` | Failure - Not Authorized |
| `4000000000000036` | Processing then Success |
| `4000000000000044` | Processing then Failure |
| `4000000000000051` | Processing then Canceled |
| `4000000000000069` | Paid then Chargebacked |
| Any other card | Not Authorized |

### Default Test Values
```
Card Number: 4556366941062122
CVV: 111
Holder Name: Aardvark da Silva
Exp Date: 12/30
Phone DDD: 11
Phone: 987654321
Document: 18152564000105
Email: aardvark.silva@gmail.com
```

**Simulator transactions expire after 30 days.**

---

## 11. Node.js SDKs

### Option A: `@pagarme/pagarme-nodejs-sdk` (RECOMMENDED)
- **Version:** 6.8.16 (latest, updated 2025-04-11)
- **API:** v5
- **Install:** `npm install @pagarme/pagarme-nodejs-sdk`
- **Repo:** https://github.com/pagarme/pagarme-nodejs-sdk

### Option B: `@pagarme/sdk`
- **Version:** 5.8.1 (last updated 2023-06-02)
- **API:** v5
- **Install:** `npm install @pagarme/sdk`
- **Repo:** https://github.com/pagarme/pagarme-core-api-nodejs

### Option C: `pagarme` (LEGACY - API v4)
- **Version:** 4.35.2 (last updated 2024-05-20)
- **API:** v4 (NOT v5)
- **Install:** `npm install pagarme`
- **DO NOT USE for new v5 integrations**

### Recommendation
Use `@pagarme/pagarme-nodejs-sdk` (v6.8.16) - it's the most actively maintained official SDK for API v5.

### Alternative: Direct HTTP Calls
For a NestJS app, you can also use `@nestjs/axios` or native `fetch` with Basic Auth:
```typescript
import { HttpService } from '@nestjs/axios';

const PAGARME_BASE_URL = 'https://api.pagar.me/core/v5';
const authHeader = 'Basic ' + Buffer.from(`${secretKey}:`).toString('base64');

// Example: Create order
const response = await this.httpService.axiosRef.post(
  `${PAGARME_BASE_URL}/orders`,
  orderBody,
  {
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
    },
  },
);
```

---

## 12. Key Integration Flow for Delivery App

### 3-Way Split Flow (Platform + Vendor + Deliverer)
1. **Register recipients** for each vendor and deliverer via `POST /recipients`
2. **Register platform** as a recipient (your marketplace account)
3. **Create customer** via `POST /customers` (or use inline customer object)
4. **Create order with split** via `POST /orders` with 3 split rules:
   - Platform fee (e.g., 10% flat)
   - Vendor share (e.g., 80%)
   - Deliverer share (e.g., 10%)
5. **Listen for webhooks** (`order.paid`, `charge.paid`, `charge.refunded`, etc.)
6. **Handle PIX QR code** - return `qr_code` and `qr_code_url` to mobile app

### Example: 3-Way Split Order
```json
{
  "items": [
    { "amount": 5000, "description": "Pedido #123", "quantity": 1 }
  ],
  "customer_id": "cus_XXXXXXXX",
  "payments": [
    {
      "payment_method": "pix",
      "pix": {
        "expires_in": 1800
      },
      "split": [
        {
          "amount": 10,
          "recipient_id": "rp_PLATFORM",
          "type": "percentage",
          "options": {
            "charge_processing_fee": true,
            "charge_remainder_fee": true,
            "liable": true
          }
        },
        {
          "amount": 80,
          "recipient_id": "rp_VENDOR",
          "type": "percentage",
          "options": {
            "charge_processing_fee": false,
            "charge_remainder_fee": false,
            "liable": false
          }
        },
        {
          "amount": 10,
          "recipient_id": "rp_DELIVERER",
          "type": "percentage",
          "options": {
            "charge_processing_fee": false,
            "charge_remainder_fee": false,
            "liable": false
          }
        }
      ]
    }
  ]
}
```
