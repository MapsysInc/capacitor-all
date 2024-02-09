package com.getcapacitor;

import static android.text.InputType.TYPE_CLASS_NUMBER;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.text.InputType;
import android.util.AttributeSet;
import android.view.KeyEvent;
import android.view.View;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.inputmethod.BaseInputConnection;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.webkit.WebView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

public class CapacitorWebView extends WebView {

    private BaseInputConnection capInputConnection;
    private Bridge bridge;

    public CapacitorWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    public void setBridge(Bridge bridge) {
        this.bridge = bridge;
    }

    @Override
    public InputConnection onCreateInputConnection(EditorInfo outAttrs) {
        CapConfig config;
        if (bridge != null) {
            config = bridge.getConfig();
        } else {
            config = CapConfig.loadDefault(getContext());
        }
       boolean captureInput = config.isInputCaptured();

        SharedPreferences prefs = getPrefs();
        String name = prefs.getString("name", "");
        String type = prefs.getString("type", "");
        if ("tel".equals(type) || "number".equals(type)){
            outAttrs.inputType = TYPE_CLASS_NUMBER;
        }
        if (captureInput) {
            if (capInputConnection == null) {
                 capInputConnection = new BaseInputConnection(this, false);
            }
            return capInputConnection;
        }
        return super.onCreateInputConnection(outAttrs);
    }


    @Override
    @SuppressWarnings("deprecation")
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getAction() == KeyEvent.ACTION_MULTIPLE) {
            evaluateJavascript("document.activeElement.value = document.activeElement.value + '" + event.getCharacters() + "';", null);
            return false;
        }
        if (event.getKeyCode()== KeyEvent.KEYCODE_NAVIGATE_NEXT && event.getAction()== KeyEvent.ACTION_DOWN)
        {
            return super.dispatchKeyEvent(new KeyEvent(KeyEvent.KEYCODE_ENTER,KeyEvent.ACTION_DOWN));
        }
        return super.dispatchKeyEvent(event);
    }
    private SharedPreferences getPrefs(){
        return getContext().getSharedPreferences("controltex.activeelement", Context.MODE_PRIVATE);
    }
}
