package com.godhex.watchparty;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HexPlugin.class);   // before super: it sets up the WebView before the site loads
        super.onCreate(savedInstanceState);
    }
}
