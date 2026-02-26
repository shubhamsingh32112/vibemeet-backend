Prerequisites
Check the prerequisites before you integrate with Razorpay Node.js server-side SDK.

Available in

IN
India

MY
Malaysia

SG
Singapore
so
Node.js Changelog

Discover new features, updates and deprecations related to the Razorpay Node.js SDK (since Jan 2024).

Troubleshooting & FAQs

Troubleshoot common error scenarios and find answers to frequently asked questions about Razorpay Node.js SDK.

Install the Razorpay Node.js SDK before you start integrating with your Node.js-based application.

Dependencies
You must use Node.js v22.2 or higher. Know more about the latest Node.js versions.

Installation
Open your project folder and run the following command on your command prompt to install the Razorpay Node.js SDK:

Install the SDK

copy

npm i razorpay
Payment Gateway

Integrate with Razorpay Payment Gateway.

API Sample Codes

Integrate using API sample codes.

Other Razorpay Products

Integrate with other Razorpay products.

Support
Queries: If you have queries, contact support.
Feature Request: If you have a feature request, raise an issue on GitHub.

Integration Steps
Integrate your Node.js-based website with our SDK to start accepting payments using the Razorpay Payment Gateway.

Available in

IN
India

MY
Malaysia

SG
Singapore

Payment Gateway

Integrate with Razorpay Payment Gateway.

Other Razorpay Products

Integrate with other Razorpay products using API sample codes.

Integrate With Razorpay Payment Gateway
Start accepting domestic and international payments from customers on your website using the Razorpay Payment Gateway. Razorpay has developed the Standard Checkout method and manages it. You can configure payment methods, orders, company logo and also select custom colour based on your convenience. Razorpay supports these payment methods and international currencies.

Configure node.js integrated payment gateway checkout based on your requirement
Watch this video to know how to integrate Razorpay Payment Gateway on your Node.js app.


Sample App

We recommend you check the Node.js Sample App, created using the video tutorial.

GitHub Repository

Download the latest razorpay-node.zip file from GitHub. It is pre-compiled to include all dependencies.

Project Structure
Before you begin, we recommend you check the Node.js Sample App, created using the video tutorial, and verify that your project contains the following files:

File Name	Purpose
index.html	Contains Checkout code.
app.js	Contains Orders API and payment verification code.
success.html	A page to redirect users once the payment is successful.
Before you proceed:

Create a Razorpay account.
Generate the API Keys from the Dashboard. To go live with the integration and start accepting real payments, generate Live Mode API Keys and replace them in the integration.
Know about the Payment Flow and follow these integration steps:
1. Build Integration

Integrate with your Node.js-based website.

2. Test Integration

Test the integration by making a test payment.

3. Go-live Checklist

Check the go-live checklist.

1. Build Integration
1.1 Instantiate Razorpay
In your server file, instantiate the Razorpay instance with your key_id and key_secret. You should generate the API keys on the Dashboard and add them here.

Given below is the command:

Instantiate the Razorpay Instance

copy

var instance = new Razorpay({
  key_id: 'YOUR_KEY_ID',
  key_secret: 'YOUR_KEY_SECRET',
});
The resources can be accessed using the instance. All the methods invocations follow the namespaced signature:

Resource

copy

// API signature
// {razorpayInstance}.{resourceName}.{methodName}(resourceId [, params])
// example

instance.payments.fetch(paymentId)
Every resource method returns a promise.

Promise

copy

instance.payments.all({
  from: '2016-08-01',
  to: '2016-08-20'
}).then((response) => {
  // handle success
}).catch((error) => {
  // handle error
})
If you want to use callbacks instead of promises, every resource method accepts a callback function as the last parameter. The callback function acts as Error First Callbacks.

Callbacks

copy

instance.payments.all({
  from: '2016-08-01',
  to: '2016-08-20'
}, (error, response) => {
  if (error) {
    // handle error
  } else {
    // handle success
  }
})
1.2 Create an Order in Server
Order is an important step in the payment process.

An order should be created for every payment.
You can create an order using the Orders API in the app.js file. It is a server-side API call. Know how to authenticate Orders API.
The order_id received in the response should be passed to checkout in the index.html file. This ties the Order with the payment and secures the request from being tampered.
Handy Tips

You can capture payments automatically with one-time Payment Capture setting configuration on the Dashboard.

1.2.1 Sample Code
In the sample app, the app.js file contains the code for order creation using Orders API.

Request
Response

copy

const Razorpay = require('razorpay');
var instance = new Razorpay({ key_id: 'YOUR_KEY_ID', key_secret: 'YOUR_SECRET' })

var options = {
  amount: 50000,  // Amount is in currency subunits. 
  currency: "INR",
  receipt: "order_rcptid_11"
};
instance.orders.create(options, function(err, order) {
  console.log(order);
});
1.2.2 Request Parameters
Here is the list of parameters for creating an order:

amount

mandatory

integer Payment amount in the smallest currency sub-unit. For example, if the amount to be charged is ₹299, then pass 29900 in this field. In the case of three decimal currencies, such as KWD, BHD and OMR, to accept a payment of 295.991, pass the value as 295990. And in the case of zero decimal currencies such as JPY, to accept a payment of 295, pass the value as 295.
Watch Out!

As per payment guidelines, you should pass the last decimal number as 0 for three decimal currency payments. For example, if you want to charge a customer 99.991 KD for a transaction, you should pass the value for the amount parameter as 99990 and not 99991.


currency

mandatory

string The currency in which the transaction should be made. See the list of supported currencies. Length must be 3 characters.
Handy Tips

Razorpay has added support for zero decimal currencies, such as JPY, and three decimal currencies, such as KWD, BHD, and OMR, allowing businesses to accept international payments in these currencies. Know more about Currency Conversion (May 2024).


receipt

optional

string Your receipt id for this order should be passed here. Maximum length is 40 characters.

notes

optional

json object Key-value pair that can be used to store additional information about the entity. Maximum 15 key-value pairs, 256 characters (maximum) each. For example, "note_key": "Beam me up Scotty”.

partial_payment

optional

boolean Indicates whether the customer can make a partial payment. Possible values:
true: The customer can make partial payments.
false (default): The customer cannot make partial payments.

first_payment_min_amount

optional

integer Minimum amount that must be paid by the customer as the first partial payment. For example, if an amount of ₹7,000 is to be received from the customer in two installments of #1 - ₹5,000, #2 - ₹2,000 then you can set this value as 500000. This parameter should be passed only if partial_payment is true.

Know more about Orders API.

1.2.3 Response Parameters
Descriptions for the response parameters are present in the Orders Entity table.

1.2.4 Error Response Parameters
The error response parameters are available in the API Reference Guide.

1.3 Add Checkout Options
Add the Razorpay Checkout options to your project. For example, if you are using HTML for your frontend, create a page called index.html and add the Pay button on your web page using the checkout code and either the callback URL or handler function.

1.3.1 Callback URL or Handler Function
Callback URL	Handler Function
When you use this:
On successful payment, the customer is redirected to the specified URL, for example, a payment success page.
On failure, the customer is asked to retry the payment.
When you use this:
On successful payment, the customer is shown your web page.
On failure, the customer is notified of the failure and asked to retry the payment.

1.3.2 Code to Add Pay Button
Copy-paste the parameters as options in your code:

Handy Tips

You can also integrate the Razorpay Checkout with React.js using the sample code.

Node.js Checkout Code


copy

<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Razorpay Payment</title>
</head>
<body>
  <h1>Razorpay Payment Gateway Integration</h1>
  <form id="payment-form">
    <label for="amount">Amount:</label>
    <input type="number" id="amount" name="amount" required>
    <button type="button" onclick="payNow()">Pay Now</button>
  </form>

  <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
  <script>
    async function payNow() {
      const amount = document.getElementById('amount').value;

      // Create order by calling the server endpoint
      const response = await fetch('/create-order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ amount, currency: 'INR', receipt: 'receipt#1', notes: {} })
      });

      const order = await response.json();

      // Open Razorpay Checkout
      const options = {
        key: 'YOUR_KEY_ID', // Replace with your Razorpay key_id
        amount: '50000', // Amount is in currency subunits.
        currency: 'INR',
        name: 'Acme Corp',
        description: 'Test Transaction',
        order_id: 'order_IluGWxBm9U8zJ8', // This is the order_id created in the backend
        callback_url: 'http://localhost:3000/payment-success', // Your success URL
        prefill: {
          name: 'Gaurav Kumar',
          email: 'gaurav.kumar@example.com',
          contact: '9999999999'
        },
        theme: {
          color: '#F37254'
        },
      };

      const rzp = new Razorpay(options);
      rzp.open();
    }
  </script>
</body>
</html>

Callback URL (JS) Checkout Code

<button id="rzp-button1">Pay with Razorpay</button>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
var options = {
    "key": "YOUR_KEY_ID", // Enter the Key ID generated from the Dashboard
    "amount": "50000", // Amount is in currency subunits. 
    "currency": "<currency>",
    "name": "Acme Corp",
    "description": "Test Transaction",
    "image": "https://example.com/your_logo",
    "order_id": "order_IluGWxBm9U8zJ8", //This is a sample Order ID. Pass the `id` obtained in the response of Step 1
    "callback_url": "https://eneqd3r9zrjok.x.pipedream.net/",
    "prefill": {
        "name": "<name>",
        "email": "<email>",
        "contact": "<phone>"
    },
    "notes": {
        "address": "Razorpay Corporate Office"
    },
    "theme": {
        "color": "#3399cc"
    }
};
var rzp1 = new Razorpay(options);
document.getElementById('rzp-button1').onclick = function(e){
    rzp1.open();
    e.preventDefault();
}
</script>

Handler Function (JS) Checkout Code

<button id="rzp-button1">Pay with Razorpay</button>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
var options = {
    "key": "YOUR_KEY_ID", // Enter the Key ID generated from the Dashboard
    "amount": "50000", // Amount is in currency subunits. 
    "currency": "<currency>",
    "name": "Acme Corp",
    "description": "Test Transaction",
    "image": "https://example.com/your_logo",
    "order_id": "order_IluGWxBm9U8zJ8", //This is a sample Order ID. Pass the `id` obtained in the response of Step 1
    "handler": function (response){
        alert(response.razorpay_payment_id);
        alert(response.razorpay_order_id);
        alert(response.razorpay_signature)
    },
    "prefill": {
        "name": "<name>",
        "email": "<email>",
        "contact": "<phone>"
    },
    "notes": {
        "address": "Razorpay Corporate Office"
    },
    "theme": {
        "color": "#3399cc"
    }
};
var rzp1 = new Razorpay(options);
rzp1.on('payment.failed', function (response){
        alert(response.error.code);
        alert(response.error.description);
        alert(response.error.source);
        alert(response.error.step);
        alert(response.error.reason);
        alert(response.error.metadata.order_id);
        alert(response.error.metadata.payment_id);
});
document.getElementById('rzp-button1').onclick = function(e){
    rzp1.open();
    e.preventDefault();
}
</script>

1.3.3 Checkout Options
key

mandatory

string API Key ID generated from the Dashboard.

amount

mandatory

integer Payment amount in the smallest currency subunit. For example, if the amount to be charged is ₹2,222.50, enter 222250 in this field. In the case of three decimal currencies, such as KWD, BHD and OMR, to accept a payment of 295.991, pass the value as 295990. And in the case of zero decimal currencies such as JPY, to accept a payment of 295, pass the value as 295.
Watch Out!

As per payment guidelines, you should pass the last decimal number as 0 for three decimal currency payments. For example, if you want to charge a customer 99.991 KD for a transaction, you should pass the value for the amount parameter as 99990 and not 99991.


currency

mandatory

string The currency in which the payment should be made by the customer. See the list of supported currencies.
Handy Tips

Razorpay has added support for zero decimal currencies, such as JPY, and three decimal currencies, such as KWD, BHD, and OMR, allowing businesses to accept international payments in these currencies. Know more about Currency Conversion (May 2024).


name

mandatory

string Your Business/Enterprise name shown on the Checkout form. For example, Acme Corp.

description

optional

string Description of the purchase item shown on the Checkout form. It should start with an alphanumeric character.

image

optional

string Link to an image (usually your business logo) shown on the Checkout form. Can also be a base64 string if you are not loading the image from a network.

order_id

mandatory

string Order ID generated via Orders API.

prefill

object You can prefill the following details at Checkout.
Boost Conversions and Minimise Drop-offs

Autofill customer contact details, especially phone number to ease form completion. Include customer’s phone number in the contact parameter of the JSON request's prefill object. Format: +(country code)(phone number). Example: "contact": "+919000090000".
This is not applicable if you do not collect customer contact details on your website before checkout, have Shopify stores or use any of the no-code apps.

notes

optional

object Set of key-value pairs that can be used to store additional information about the payment. It can hold a maximum of 15 key-value pairs, each 256 characters long (maximum).

theme

object Thematic options to modify the appearance of Checkout.

color

optional

string Enter your brand colour's HEX code to alter the text, payment method icons and CTA (call-to-action) button colour of the Checkout form.

backdrop_color

optional

string Enter a HEX code to change the Checkout's backdrop colour.

modal

object Options to handle the Checkout modal.

backdropclose

optional

boolean Indicates whether clicking the translucent blank space outside the Checkout form should close the form. Possible values:
true: Closes the form when your customer clicks outside the checkout form.
false (default): Does not close the form when customer clicks outside the checkout form.

escape

optional

boolean Indicates whether pressing the escape key should close the Checkout form. Possible values:
true (default): Closes the form when the customer presses the escape key.
false: Does not close the form when the customer presses the escape key.

handleback

optional

boolean Determines whether Checkout must behave similar to the browser when back button is pressed. Possible values:
true (default): Checkout behaves similarly to the browser. That is, when the browser's back button is pressed, the Checkout also simulates a back press. This happens as long as the Checkout modal is open.
false: Checkout does not simulate a back press when browser's back button is pressed.

confirm_close

optional

boolean Determines whether a confirmation dialog box should be shown if customers attempts to close Checkout. Possible values:
true: Confirmation dialog box is shown.
false (default): Confirmation dialog box is not shown.

ondismiss

optional

function Used to track the status of Checkout. You can pass a modal object with ondismiss: function()\{\} as options. This function is called when the modal is closed by the user. If retry is false, the ondismiss function is triggered when checkout closes, even after a failure.

animation

optional

boolean Shows an animation before loading of Checkout. Possible values:
true(default): Animation appears.
false: Animation does not appear.

subscription_id

optional

string If you are accepting recurring payments using Razorpay Checkout, you should pass the relevant subscription_id to the Checkout. Know more about Subscriptions on Checkout.

subscription_card_change

optional

boolean Permit or restrict customer from changing the card linked to the subscription. You can also do this from the hosted page. Possible values:
true: Allow the customer to change the card from Checkout.
false (default): Do not allow the customer to change the card from Checkout.

recurring

optional

boolean Determines if you are accepting recurring (charge-at-will) payments on Checkout via instruments such as emandate, paper NACH and so on. Possible values:
true: You are accepting recurring payments.
false (default): You are not accepting recurring payments.

callback_url

optional

string Customers will be redirected to this URL on successful payment. Ensure that the domain of the Callback URL is allowlisted.

redirect

optional

boolean Determines whether to post a response to the event handler post payment completion or redirect to Callback URL. callback_url must be passed while using this parameter. Possible values:
true: Customer is redirected to the specified callback URL in case of payment failure.
false (default): Customer is shown the Checkout popup to retry the payment with the suggested next best option.

customer_id

optional

string Unique identifier of customer. Used for:
Local saved cards feature.
Static bank account details on Checkout in case of Bank Transfer payment method.

remember_customer

optional

boolean Determines whether to allow saving of cards. Can also be configured via the Dashboard. Possible values:
true: Enables card saving feature.
false (default): Disables card saving feature.

timeout

optional

integer Sets a timeout on Checkout, in seconds. After the specified time limit, the customer will not be able to use Checkout.
Watch Out!

Some browsers may pause JavaScript timers when the user switches tabs, especially in power saver mode. This can cause the checkout session to stay active beyond the set timeout duration.


readonly

object Marks fields as read-only.

contact

optional

boolean Used to set the contact field as readonly. Possible values:
true: Customer will not be able to edit this field.
false (default): Customer will be able to edit this field.

email

optional

boolean Used to set the email field as readonly. Possible values:
true: Customer will not be able to edit this field.
false (default): Customer will be able to edit this field.

name

optional

boolean Used to set the name field as readonly. Possible values:
true: Customer will not be able to edit this field.
false (default): Customer will be able to edit this field.

hidden

object Hides the contact details.

contact

optional

boolean Used to set the contact field as optional. Possible values:
true: Customer will not be able to view this field.
false (default): Customer will be able to view this field.

email

optional

boolean Used to set the email field as optional. Possible values:
true: Customer will not be able to view this field.
false (default): Customer will be able to view this field.

send_sms_hash

optional

boolean Used to auto-read OTP for cards and netbanking pages. Applicable from Android SDK version 1.5.9 and above. Possible values:
true: OTP is auto-read.
false (default): OTP is not auto-read.

allow_rotation

optional

boolean Used to rotate payment page as per screen orientation. Applicable from Android SDK version 1.6.4 and above. Possible values:
true: Payment page can be rotated.
false (default): Payment page cannot be rotated.

retry

optional

object Parameters that enable retry of payment on the checkout.

enabled

boolean Determines whether the customers can retry payments on the checkout. Possible values:
true (default): Enables customers to retry payments.
false: Disables customers from retrying the payment.

max_count

integer The number of times the customer can retry the payment. We recommend you to set this to 4. Having a larger number here can cause loops to occur.
Watch Out!

Web Integration does not support the max_count parameter. It is applicable only in Android and iOS SDKs.


config

optional

object Parameters that enable checkout configuration. Know more about how to configure payment methods on Razorpay standard checkout.

display

object Child parameter that enables configuration of checkout display language.

1.3.4 Handle Payment Success and Failure
The way the Payment Success and Failure scenarios are handled depends on the Checkout Sample Code you used in the last step.

Checkout with Callback URL
If you used the sample code with the callback URL:


On Payment Success




Razorpay makes a POST call to the callback URL with the razorpay_payment_id, razorpay_order_id and razorpay_signature in the response object of the successful payment. Only successful authorisations are auto-submitted.

On Payment Failure

In case of failed payments, the checkout is displayed again to facilitate payment retry.



Checkout with Handler Function
If you used the sample code with the handler function:


On Payment Success
The customer sees your website page. The checkout returns the response object of the successful payment (razorpay_payment_id, razorpay_order_id and razorpay_signature). Collect these and send them to your server.


On Payment Failure

The customer is notified about payment failure and asked to retry the payment.


Use the Success/Failure Handling code given below:

Success Handling Code
Failure Handling Code

copy

"handler": function (response){
    alert(response.razorpay_payment_id);
    alert(response.razorpay_order_id);
    alert(response.razorpay_signature)}


    1.3.5 Configure Payment Methods (Optional)
Multiple payment methods are available on Razorpay Standard Checkout.

The payment methods are fixed and cannot be changed.
You can configure the order or make certain payment methods prominent. Know more about configuring payment methods. Know more about configuring payment methods.


1.3.5 Configure Payment Methods (Optional)

1.4 Store Fields in Your Server
A successful payment returns the following fields to the Checkout form.

Success Callback
You need to store these fields in your server.
You can confirm the authenticity of these details by verifying the signature in the next step.
Success Callback

copy

{
  "razorpay_payment_id": "pay_29QQoUBi66xm2f",
  "razorpay_order_id": "order_9A33XWu170gUtm",
  "razorpay_signature": "9ef4dffbfd84f1318f6739a3ce19f9d85851857ae648f114332d8401e0949a3d"
}

razorpay_payment_id

string Unique identifier for the payment returned by Checkout only for successful payments.

razorpay_order_id

string Unique identifier for the order returned by Checkout.

razorpay_signature

string Signature returned by the Checkout. This is used to verify the payment.



1.5 Verify Payment Signature
This is a mandatory step that allows you to confirm the authenticity of the details returned to the checkout for successful payments.

To verify the razorpay_signature returned to you by the checkout:

Create a signature in your server using the following attributes:

Attribute	Description
order_id	Retrieve the order_id from your server. Do not use the razorpay_order_id returned by checkout.
razorpay_payment_id	Returned during checkout.
key_secret	Available in your server. The key_secret that was generated from the Dashboard .
Use the SHA256 algorithm, the razorpay_payment_id and the order_id to construct an HMAC hex digest as shown below:


copy

generated_signature = hmac_sha256(order_id + "|" + razorpay_payment_id, secret);

    if (generated_signature == razorpay_signature) {
    payment is successful
     }
If the signature you generate on your server matches the razorpay_signature returned to you by the checkout, the payment received is from an authentic source.

Use the code given below to generate signature on your server:

Verify Payment Signature

copy

var instance = new Razorpay({ key_id: 'YOUR_KEY_ID', key_secret: 'YOUR_SECRET' })

var { validatePaymentVerification, validateWebhookSignature } = require('./dist/utils/razorpay-utils');
validatePaymentVerification({"order_id": razorpayOrderId, "payment_id": razorpayPaymentId }, signature, secret);
Add the following code in the front-end:

Call Signature Validate Method

copy

var settings = {
  "url": "/api/payment/verify",
  "method": "POST",
  "timeout": 0,
  "headers": {
   "Content-Type": "application/json"
  },
  "data": JSON.stringify({response}),
}



1.6 Verify Payment Status
Handy Tips

On the Dashboard, ensure that the payment status is captured. Refer to the payment capture settings page to know how to capture payments automatically.

You can track the payment status in three ways:


Verify Status from Dashboard


Subscribe to Webhook Events


Poll APIs

To verify the payment status from the Dashboard:

Log in to the Dashboard and navigate to Transactions → Payments.
Check if a Payment Id has been generated and note the status. In case of a successful payment, the status is marked as Captured.





