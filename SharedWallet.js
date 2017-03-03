"use strict";

var Ariel = { sharedWallet: {} };

Ariel.sharedWallet.SharedWallet = function (uihost, rootURL) {
    this._uihost = uihost;
    this._rootURL = rootURL;
    this._username = "";
    this._password = "";
};

Ariel.sharedWallet.formatNumberAsCurrency = function (number, currencySymbol, showPlusForPositive) {
    return (showPlusForPositive && number > 0 ? "+":"") + currencySymbol + number.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
};

Ariel.sharedWallet.generateRandomUID = function () {
    function s4() { return Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1); };
    return s4() + s4() + '-' + s4() + '-' + s4() + '-' + s4() + '-' + s4() + s4() + s4();
};
Ariel.sharedWallet.openDialog = function (uri, name, options, closeCallback) {
    var win = window.open(uri, name, options);
    var interval = window.setInterval(function () {
        try {
            if (win == null || win.closed) {
                window.clearInterval(interval);
                closeCallback(win);
            }
        }
        catch (e) {
        }
    }, 1000);
    return win;
};

Ariel.sharedWallet.SharedWallet.prototype = {

    constructor: Ariel.sharedWallet.SharedWallet,

    setCredentials: function (username, password) {
        this._username = username;
        this._password = hex_md5(password);
    },

    refresh: function () {
        var _self = this;
        var logondetails = { Username: this._username, HashedPassword: this._password };
        $.ajax({
            url: _self._rootURL + "/account/Authenticate",
            type: "POST",
            data: logondetails,
            dataType: "json",
            success: function (data) {
                // Update the UI...
                _self.constructUI(data);
            }
        });
    },


    // Construct UI
    constructUI: function (data) {
        // Clear the content of the uihost
        var _self = this;
        var parent = this._uihost;
        parent.empty();

        // Find the total available funds in all accounts (this is used to scale the UI)
        var unallocatedmywallet = data.UnallocatedFunds;
        var totalwalletfunds = 0;
        totalwalletfunds += unallocatedmywallet;
        for (var n = 0; n < data.Platforms.length; n++) {
            // Walk through the currencies in each platform
            for (var m = 0; m < data.Platforms[n].Currencies.length; m++) {
                totalwalletfunds += data.Platforms[n].Currencies[m].ReservedFunds;
                totalwalletfunds += data.Platforms[n].Currencies[m].AvailableFunds;
            }
        }

	// Add logo
	$('<div class="logo"></div>').appendTo(parent);

        // Add mywallet
        addAccountRow(parent, 0, totalwalletfunds, { type: "mywallet", Name: "MY WALLET", unallocatedFunds: unallocatedmywallet, Currency: data.Currency }, data, data.ExchangeRates);

        // Add tradingaccounts
        var divTradingAccounts = $('<div class="tradingaccounts"></div>').appendTo(parent);
        for (var n = 0; n < data.Platforms.length; n++) {
            var account = data.Platforms[n];
            account.type = "trading";
            // Add each currency
            for (var m = 0; m < account.Currencies.length; m++) {
                addAccountRow(divTradingAccounts, unallocatedmywallet, totalwalletfunds, account, account.Currencies[m], data.ExchangeRates);
            }
        }
        // Add creditdebits
        var divPaymentProviders = $('<div class="paymentproviders"></div>').appendTo(parent);
        for (var n = 0; n < data.PaymentProviders.length; n++) {
            var paymentprovider = data.PaymentProviders[n];
            paymentprovider.type = "paymentprovider";
            addAccountRow(divPaymentProviders, unallocatedmywallet, totalwalletfunds, paymentprovider, paymentprovider, data.ExchangeRates);
        }
        // Add toolbar
        var toolbar = $('<div class="toolbar"></div>').appendTo(this._uihost);
        var resetButton = $('<div class="reset button">RESET</div>').appendTo(toolbar);
        resetButton.click(resetButton_Click);
        var applyButton = $('<div class="apply button">APPLY</div>').appendTo(toolbar);
        applyButton.click(applyButton_Click);


        // *** EVENT HANDLERS ***
        function resetButton_Click() {
            // Reset all sliders to original positions (i.e zero) then recalc my wallet
            parent.find('.slider').slider('value', 0);
            parent.find('.account input').val('');
            recalculateMyWallet();
        }
        function applyButton_Click() {


            // Do we have any deposits to make from payment providers?
            for (var n = 0; n < data.PaymentProviders.length; n++) {
                var paymentprovider = data.PaymentProviders[n];

                // Has a request been made?
                var adjustment = parent.find('.account.paymentprovider[accountname="' + paymentprovider.Name + '"] .fundsgraphic .slider').slider('value');
                if (adjustment < 0) {
                    // We need to make a deposit request from this provider
                    var uid = Ariel.sharedWallet.generateRandomUID();
                    $.ajax({
                        url: _self._rootURL + "/transaction/StartPaymentTransaction",
                        type: "POST",
                        data: {
                            UID: uid,
                            Credentials: { Username: _self._username, HashedPassword: _self._password },
                            Transactions: [{ Name: paymentprovider.Name, Adjustment: -adjustment, Currency: paymentprovider.Currency}]
                        },
                        dataType: "json",
                        success: function (data) {
                            if (data) {
                                // This should return us a URL whcih we should throw a popup of
                                var popupid = 'sharedwallet_' + paymentprovider.Name + '_' + uid;
                                var transactionDialog = Ariel.sharedWallet.openDialog(data,
                                        popupid,
                                        "status=yes, height=880; width=880; resizeable=1",
                                        function (window) {
                                            alert("Dialog closed");
                                        });
                            }
                        }
                    });

                    // Further transfers actions need to be held back for now...
                    return;
                }
            }

            // If we are here, then there were no payment provider requests...
            sendPlatformAccountAdjustmentRequests();
        }

        function sendPlatformAccountAdjustmentRequests() {
            // Prepare data block to send to server describing all the movements
            var req = [];
            for (var n = 0; n < data.Platforms.length; n++) {
                var account = data.Platforms[n];

                // Has this account been adjusted?
                var adjustment = parent.find('.account.trading[accountname="' + account.Name + '"] .fundsgraphic .slider').slider('value');
                if (adjustment != 0) {
                    req.push({ Name: account.Name, Adjustment: adjustment });
                }
            }

            // If we've made some adjustments, send them to the server
            if (req.length > 0) {

                // Add some authentication to this message
                var uid = Ariel.sharedWallet.generateRandomUID();
                var message =
                {
                    UID: uid,
                    Credentials: { Username: _self._username, HashedPassword: _self._password },
                    Transactions: req
                };
                $.ajax({
                    url: _self._rootURL + "/transaction/Add",
                    type: "POST",
                    data: message,
                    dataType: "json",
                    success: function (data) {

                        clearInterval(checkTimer);

                        // The data object should be the transactions object populated with sucess flags and reasons for failure
                        if (data.Success) {
                            alert(req.length + ' transaction' + (req.length > 1 ? 's' : '') + ' completed successfully');
                        }
                        else {
                            var s = 'Not all transactions completed successfully...\n';
                            for (var i in data.Transactions) {
                                var trans = data.Transactions[i];
                                if (!trans.Success) {
                                    s += ' - ' + trans.Message + '\n';
                                }
                            }
                            alert(s);
                        }

                        // Rerequest all accounts to get new values
                        _self.refresh();
                    }
                });

                // Periodically check the progress on this transaction
                var checkTimer = setInterval(function () {

                    var message =
                    {
                        UID: uid,
                        Credentials: { Username: _self._username, HashedPassword: _self._password }
                    };

                    $.ajax({
                        url: _self._rootURL + "/transaction/QueryTransactionProgress",
                        type: "POST",
                        data: message,
                        dataType: "json",
                        success: function (data) {
                            console.log(data);
                        }
                    });
                }, 1000);
            }
        }


        function addAccountRow(rowparent, mywalletfunds, totalwalletfunds, settings, currency, exchangeRates) {
            //var currency = settings.Currency;
            var currencySymbol = (currency ? currency.Currency : settings.Currency);

            // Look up exchange rate
            var exRate = 1.0;
            if (exchangeRates.hasOwnProperty(currencySymbol)) {
                exRate = exchangeRates[currencySymbol];
            }

            var div = $('<div class="account ' + settings.type + '" accountname="' + settings.Name + '" exrate="' + exRate + '"></div>').appendTo(rowparent);

            // Add title
            div.append('<div class="title">' + settings.Name + ' - ' + currencySymbol + '</div>');
//            div.append('<div class="title">' + settings.Name + ' - ' + currencySymbol + ' - ' + exRate + '</div>');
            if (settings.type == "mywallet") {
                div.append('<div class="title right mywalletunallocatedfunds">' + Ariel.sharedWallet.formatNumberAsCurrency(settings.unallocatedFunds, currencySymbol) + '</div>');
            }

            //TODO: Add info button/icon


            if (settings.type == "trading") {
                // Add reserved and available labels
                div.append('<div class="subtitle reserved">Reserved Funds: ' + Ariel.sharedWallet.formatNumberAsCurrency(currency.ReservedFunds, currencySymbol) + '</div>');
                div.append('<div class="subtitle available">Funds Available: ' + Ariel.sharedWallet.formatNumberAsCurrency(currency.AvailableFunds, currencySymbol) + '</div>');
            }

            if (settings.type == "paymentprovider") {
                // Add deposit and withdraw labels
                div.append('<div class="subtitle deposit">Deposit (xxx max)' + '</div>');
                div.append('<div class="subtitle withdraw">Withdraw</div>');
            }

            // Add graphics area for slider, colours etc
            var slider;
            var fundsgraphic = $('<div class="fundsgraphic"></div>').appendTo(div);
            if (settings.type == "mywallet") {
                var availableWidth = settings.unallocatedFunds / totalwalletfunds * 100;
                fundsgraphic.append('<div class="available" style="width:' + availableWidth + '%;">&nbsp;</div>');
            }
            if (settings.type == "trading") {
                var reservedWidth = currency.ReservedFunds / totalwalletfunds * 100;
                fundsgraphic.append('<div class="reserved" style="width:' + reservedWidth + '%;">&nbsp;</div>');
                var availableWidth = currency.AvailableFunds / totalwalletfunds * 100;
                fundsgraphic.append('<div class="available" style="left:' + reservedWidth + '%;width:' + availableWidth + '%;">&nbsp;</div>');
                var sliderWidth = (mywalletfunds + currency.AvailableFunds) / totalwalletfunds * 100;

                // Add slider
                var minValue = -currency.AvailableFunds;
                if (minValue - Math.floor(minValue) != 0) {
                    minValue = Math.floor(minValue) + 1;
                }
                slider = $('<div class="slider" style="left:' + reservedWidth + '%;width:' + sliderWidth + '%;"></div>').appendTo(fundsgraphic);
                slider.slider({
                    orientation: "horizontal",
                    range: "min",
                    min: minValue,
                    max: mywalletfunds,
                    value: 0,
                    slide: sliderMoved,
                    change: sliderMoved,
                    stop: sliderMoved
                });
            }
            if (settings.type == "paymentprovider") {
                var zeroPoint = 10000 / (mywalletfunds + 10000) * 100;
                fundsgraphic.append('<div class="transfer" style="left:' + zeroPoint + '%;width:0;">&nbsp;</div>');
                // Add slider
                slider = $('<div class="slider" style="left:0;width:100%;"></div>').appendTo(fundsgraphic);
                slider.slider({
                    orientation: "horizontal",
                    range: "min",
                    min: -10000,
                    max: mywalletfunds,
                    value: 0,
                    slide: sliderMoved,
                    change: sliderMoved,
                    stop: sliderMoved
                });
            }


            // Add summary text field
            var transfersummary;
            var depositinput;
            var withdrawinput;
            if (settings.type == "trading") {
                transfersummary = $('<input class="transfersummary" placeholder="-/+ ' + currencySymbol + '"></input>').appendTo(div);
            }
            if (settings.type == "paymentprovider") {
                depositinput = $('<input class="deposit" placeholder="' + currencySymbol + '"></input>').appendTo(div);
                withdrawinput = $('<input class="withdraw" placeholder="' + currencySymbol + '"></input>').appendTo(div);
            }

            // Event handling
            function sliderMoved(event, ui) {
                if (event.originalEvent) {
                    // Is this a platform (i.e. is there a summary text field)?
                    if (transfersummary) {
                        transfersummary.val(Ariel.sharedWallet.formatNumberAsCurrency(ui.value, currencySymbol, true));
                    }
                    // Is this a payment provider?
                    if (depositinput && withdrawinput) {
                        var paymentProviderAdjustment = ui.value;
                        var newMyWalletFunds = unallocatedmywallet;
                        var sliders = parent.find('.slider');
                        for (var n = 0; n < sliders.length; n++) {
                            // Don't include ourselves
                            if (!(event.target === sliders[n])) {
                                newMyWalletFunds -= $(sliders[n]).slider('value');
                            }
                        }
                        if (paymentProviderAdjustment > 0) {
                            depositinput.val('');
                            withdrawinput.val(Ariel.sharedWallet.formatNumberAsCurrency(paymentProviderAdjustment, currencySymbol, false));

                            // Resize the transfer object
                            var width = (paymentProviderAdjustment) / (newMyWalletFunds + 10000) * 100;
                            var zeroPoint = 10000 / (newMyWalletFunds + 10000) * 100;
                            fundsgraphic.children('.transfer').css('left', zeroPoint + '%').css('width', width + '%');
                        }
                        else {
                            withdrawinput.val('');
                            depositinput.val(Ariel.sharedWallet.formatNumberAsCurrency(-paymentProviderAdjustment, currencySymbol, false));

                            // If there is less in the wallet now than we're depositing, do not reduce any more
                            var width = (-paymentProviderAdjustment) / (newMyWalletFunds + 10000) * 100;
                            var zeroPoint = 10000 / (newMyWalletFunds + 10000) * 100;

                            if (newMyWalletFunds < 0) {
                                var width = (-paymentProviderAdjustment) / 10000 * 100;
                                var zeroPoint = 100;
                            }

                            // Resize the transfer object
                            fundsgraphic.children('.transfer').css('left', (zeroPoint - width) + '%').css('width', width + '%');
                        }
                    }
                    recalculateMyWallet(this);
                }
                else {
                    //programmatic change
                }
            }
            // Bind to text field change
            if (transfersummary) {
                transfersummary.bind('input propertychange', function (event) {
                    // Try to parse the value
                    var value = Number(transfersummary.val().replace(/[^0-9-\.]+/g, ""));
                    if (value != NaN) {
                        // Is it valid, i.e. with in the min and max of the slider
                        var min = slider.slider("option", "min");
                        var max = slider.slider("option", "max");
                        if (value >= min && value <= max) {
                            // Is this different to the slider value?
                            if (value != slider.slider("value")) {
                                slider.slider("value", value);
                                recalculateMyWallet(this);
                            }
                        }
                    }
                });
                transfersummary.change(function (event) {
                    // We've lost focus, so format the number
                    // Try to parse the value
                    var value = Number(transfersummary.val().replace(/[^0-9-\.]+/g, ""));
                    if (value == NaN) {
                        // Set the text box back to the slider value
                        transfersummary.val(Ariel.sharedWallet.formatNumberAsCurrency(slider.slider("value"), currencySymbol, true));
                    }
                    else {
                        // Is it valid, i.e. with in the min and max of the slider
                        var min = slider.slider("option", "min");
                        var max = slider.slider("option", "max");
                        if (value >= min && value <= max) {
                            transfersummary.val(Ariel.sharedWallet.formatNumberAsCurrency(slider.slider("value"), currencySymbol, true));
                        }
                    }
                });
            }
        }

        function recalculateMyWallet(excludedSlider) {

            // Add up all slider values + unallocatedmywallet and set the myaccount bar as appropriate
            var newMyWalletFunds = unallocatedmywallet;
            var sliders = parent.find('.account.trading .fundsgraphic .slider');
            for (var n = 0; n < sliders.length; n++) {
                // Get the exchange rate for this slider
                var exRate = 1.0;
                if ($(sliders[n]) && $(sliders[n]).parent() && $(sliders[n]).parent().parent()) {
                    exRate = parseFloat($(sliders[n]).parent().parent().attr('exrate'));
                    if (exRate == NaN || exRate == 0.0) {
                        exRate = 1.0;
                    }
                }
                newMyWalletFunds -= ($(sliders[n]).slider('value') * exRate);
            }

            // Add to the newMyWalletFunds any payment provider deposits
            var newtotalwalletfunds = totalwalletfunds;
            var ppsliders = parent.find('.account.paymentprovider .fundsgraphic .slider');
            for (var n = 0; n < ppsliders.length; n++) {
                var ppvalue = $(ppsliders[n]).slider('value');
                newMyWalletFunds -= ppvalue;

                // If this PP is depositiing, then we should increase our total funds
                if (ppvalue < 0) {
                    newtotalwalletfunds += (-ppvalue);
                }
            }

            // Set the text field
            $('.mywalletunallocatedfunds').html(Ariel.sharedWallet.formatNumberAsCurrency(newMyWalletFunds, data.Currency));
            $('.account.mywallet .available').css('width', newMyWalletFunds / newtotalwalletfunds * 100 + '%');

            // Set the maximum (and width) on each slider
            for (var n = 0; n < sliders.length; n++) {
                if (!(excludedSlider === sliders[n])) {
                    var availableFunds = -$(sliders[n]).slider("option", "min");
                    var additionalFunds = $(sliders[n]).slider("value");

                    var sliderWidth = (newMyWalletFunds + additionalFunds + availableFunds) / newtotalwalletfunds * 100;
                    var reservedWidth = data.Platforms[n].ReservedFunds / newtotalwalletfunds * 100;
                    var availableWidth = availableFunds / newtotalwalletfunds * 100;

                    $(sliders[n]).parent().children('.reserved').css('width', reservedWidth + '%');
                    $(sliders[n]).parent().children('.available').css('left', reservedWidth + '%').css('width', availableWidth + '%');
                    $(sliders[n]).css('left', reservedWidth + '%').css('width', sliderWidth + '%');
                    $(sliders[n]).slider("option", "max", newMyWalletFunds + additionalFunds);
                }
            }
            // Set the maximum (and width) on each payment provider slider
            for (var n = 0; n < ppsliders.length; n++) {
                if (!(excludedSlider === ppsliders[n])) {

                    var paymentProviderAdjustment = $(ppsliders[n]).slider("value");
                    // Maximum that can be withdrawn is the newMyWalletFunds excluding transfers to this provider 
                    var maximumWithdraw = newMyWalletFunds + paymentProviderAdjustment;
                    if (maximumWithdraw < 0) {
                        maximumWithdraw = 0;
                    }

                    if (paymentProviderAdjustment > 0) {
                        // Resize the transfer object
                        var width = (paymentProviderAdjustment) / (maximumWithdraw + 10000) * 100;
                        var zeroPoint = 10000 / (maximumWithdraw + 10000) * 100;
                        $(ppsliders[n]).parent().children('.transfer').css('left', zeroPoint + '%').css('width', width + '%');
                        $(ppsliders[n]).slider("option", "max", maximumWithdraw);
                        $(ppsliders[n]).css('width', '100%');
                    }
                    else {
                        // Resize the transfer object
                        var width = (-paymentProviderAdjustment) / (maximumWithdraw + 10000) * 100;
                        var zeroPoint = 10000 / (maximumWithdraw + 10000) * 100;
                        $(ppsliders[n]).parent().children('.transfer').css('left', (zeroPoint - width) + '%').css('width', width + '%');

                        // Prevent retraction of the deposit by any amount now allocated to other accounts
                        if (maximumWithdraw == 0) {
                            var maxSliderValue = -(-paymentProviderAdjustment - newMyWalletFunds);
                            $(ppsliders[n]).slider("option", "max", maxSliderValue);
                            width = (10000 + maxSliderValue) / 10000 * 100;
                            $(ppsliders[n]).css('width', width + '%');
                        }
                        else {
                            $(ppsliders[n]).slider("option", "max", maximumWithdraw);
                            $(ppsliders[n]).css('width', '100%');
                        }
                    }
                }
            }
        }

    }
};