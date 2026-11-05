package org.vslabs.wam_miner;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;

import java.util.LinkedList;

public class LogsActivity extends AppCompatActivity {
    private static final String TAG = "WAM_APK_LOGS_UI";

    private TextView logTextView;
    private ScrollView scrollView;
    private boolean isReceiverRegistered = false;
    private final LinkedList<String> logLines = new LinkedList<>();

    // Dynamic dual receiver: listens for logs and checks for external service drops
    private final BroadcastReceiver syncLogAndQuitReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null) return;
            String action = intent.getAction();

            if (MinerNativeService.ACTION_NATIVE_LOG_BROADCAST.equals(action)) {
                String logLine = intent.getStringExtra("LOG_LINE");
                if (logLine != null) {
                    logLines.add(logLine);
                    if (logLines.size() > 150) {
                        logLines.removeFirst();
                    }
                    StringBuilder displayBuffer = new StringBuilder();
                    for (String line : logLines) {
                        displayBuffer.append(line).append("\n");
                    }
                    logTextView.setText(displayBuffer.toString());
                    scrollView.post(() -> scrollView.fullScroll(ScrollView.FOCUS_DOWN));
                }
            }
            // If the service drops via notification bar control, close logs instantly
            else if (MinerNativeService.ACTION_STOP_NATIVE.equals(action)) {
                Log.i(TAG, "Miner core closure broadcast intercepted. Popping out layout screen.");
                finish();
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        scrollView = new ScrollView(this);
        scrollView.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        scrollView.setBackgroundColor(0xFF121212);

        logTextView = new TextView(this);
        logTextView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        logTextView.setPadding(40, 40, 40, 40);
        logTextView.setTextSize(13);
        logTextView.setTextColor(0xFF00FF00);
        logTextView.setTypeface(android.graphics.Typeface.MONOSPACE);

        scrollView.addView(logTextView);
        setContentView(scrollView);

        logTextView.setText("--- WAM NATIVE CONSOLE INTERFACE LINE ACTIVE ---\nInitializing mining cores. Waiting for pool job templates...\n");

        // Handle modern hardware/gesture back intercept loop matching CompileSDK 33 requirements
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                showTerminationConfirmationDialog();
            }
        });
    }

    private void showTerminationConfirmationDialog() {
        new AlertDialog.Builder(this)
                .setTitle("Stop Mining Engine?")
                .setMessage("Exiting this window will completely terminate background operations. Continue?")
                .setPositiveButton("Stop & Exit", (dialog, which) -> {
                    Log.i(TAG, "Operator confirmed window dismissal. Killing background processing threads.");
                    terminateMinerServiceExplicitly();
                    finish(); // Slide cleanly down to ConfigActivity
                })
                .setNegativeButton("Cancel", (dialog, which) -> dialog.dismiss())
                .setCancelable(true)
                .show();
    }

    private void terminateMinerServiceExplicitly() {
        Intent stopIntent = new Intent(this, MinerNativeService.class);
        stopIntent.setAction(MinerNativeService.ACTION_STOP_NATIVE);
        startService(stopIntent);
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (!isReceiverRegistered) {
            IntentFilter filter = new IntentFilter();
            filter.addAction(MinerNativeService.ACTION_NATIVE_LOG_BROADCAST);
            filter.addAction(MinerNativeService.ACTION_STOP_NATIVE);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(syncLogAndQuitReceiver, filter, Context.RECEIVER_EXPORTED);
            } else {
                registerReceiver(syncLogAndQuitReceiver, filter);
            }
            isReceiverRegistered = true;
        }
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (isReceiverRegistered) {
            try {
                unregisterReceiver(syncLogAndQuitReceiver);
            } catch (Exception e) {
                // Already safe
            }
            isReceiverRegistered = false;
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
    }
}
