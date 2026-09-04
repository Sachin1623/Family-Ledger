package com.familyledger.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AiSharePlugin.class);
        registerPlugin(AlarmClockPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
