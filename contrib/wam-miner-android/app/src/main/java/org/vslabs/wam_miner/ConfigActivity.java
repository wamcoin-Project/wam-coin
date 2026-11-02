package org.vslabs.wam_miner;

import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.Log;
import android.view.View;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.EditText;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;

import org.vslabs.model.MinerConfigModel;
import org.vslabs.model.PoolObject;

import java.io.OutputStream;
import java.lang.reflect.Type;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.stream.Collectors;

import javax.net.ssl.HttpsURLConnection;

public class ConfigActivity extends AppCompatActivity {

    MinerConfigModel configObject = null;
    List<PoolObject> poolsObject = null;
    private final int coreMax = Runtime.getRuntime().availableProcessors();
    TextView txt = null;
    String device_id = null;
    Spinner poolChoicesSpinner = null;
    Spinner portChoicesSpinner = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_config);

        device_id = this.getIntent().getStringExtra("DEVICE_ID");
        String hwinfo = this.getIntent().getStringExtra("HWINFO");
        String jsonString = this.getIntent().getStringExtra("POOLS");

        Log.d("gvsdebug", "poolstring received in config=\n" + jsonString);

        ((TextView) findViewById(R.id.config_hwinfo)).setText("Current Hardware Information:\n" + hwinfo);

//        Toast.makeText(ConfigActivity.this, "gvsdebug" + jsonString, Toast.LENGTH_LONG).show();
        poolChoicesSpinner = findViewById(R.id.poolChoices);
        portChoicesSpinner = findViewById(R.id.portChoices);

        if (jsonString != null) {
            Gson gson = new Gson();
            Type type = new TypeToken<List<PoolObject>>() {
            }.getType();
            poolsObject = gson.fromJson(jsonString, type);
            Log.d("gvdebug", "poolsobject received=\n" + poolsObject);

            ArrayAdapter<PoolObject> poolAdapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item, poolsObject);
            // 4. Specify the layout layout style for the dropdown choices
            poolAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
// 5. Apply the adapter to the Spinner
            poolChoicesSpinner.setAdapter(poolAdapter);
// 6. Set the default selected option
            int defaultPosition = 0; // This will select "Pool Option C"
            poolChoicesSpinner.setSelection(defaultPosition);

            Integer[] portsList = Arrays.stream(((PoolObject) poolChoicesSpinner.getSelectedItem()).ports).boxed().toArray(Integer[]::new);
            ArrayAdapter<Integer> portAdapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item, portsList);
            // 4. Specify the layout layout style for the dropdown choices
            portAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
// 5. Apply the adapter to the Spinner
            portChoicesSpinner.setAdapter(portAdapter);
            portChoicesSpinner.setSelection(0);
        }

        poolChoicesSpinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                // 1. Retrieve the selected PoolObject instance safely
                PoolObject selectedPool = (PoolObject) parent.getItemAtPosition(position);

                if (selectedPool != null && selectedPool.ports != null) {
                    // 2. Convert primitive int[] to a List<Integer> using Java Streams
                    List<Integer> portList = Arrays.stream(selectedPool.ports)
                            .boxed()
                            .collect(Collectors.toList());

                    // 3. Create a fresh adapter for the ports dropdown list
                    ArrayAdapter<Integer> portAdapter = new ArrayAdapter<>(
                            ConfigActivity.this,
                            android.R.layout.simple_spinner_item,
                            portList
                    );
                    portAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);

                    // 4. Update the port spinner layout on the fly
                    portChoicesSpinner.setAdapter(portAdapter);
                }
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {
                // Optional: Handle case where selection disappears completely
            }
        });

        configObject = (MinerConfigModel) this.getIntent().getSerializableExtra("CONFIG");
        if (configObject != null) {
            for (int ctr = 0; ctr < poolChoicesSpinner.getCount(); ctr++) {
                if (((PoolObject) poolChoicesSpinner.getItemAtPosition(ctr)).url.equalsIgnoreCase(configObject.stratum)) {
                    poolChoicesSpinner.setSelection(ctr);
                    ctr = poolChoicesSpinner.getCount();
                }
            }
            for (int ctr = 0; ctr < portChoicesSpinner.getCount(); ctr++) {
                if (Integer.parseInt(portChoicesSpinner.getItemAtPosition(ctr).toString()) == configObject.port) {
                    portChoicesSpinner.setSelection(ctr);
                    ctr = portChoicesSpinner.getCount();
                }
            }
        }


        txt = findViewById(R.id.input_cores);
        txt.setText("1");

        // Add the text change listener
        txt.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {
                // Triggered right BEFORE the text changes
            }

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {
                // Triggered WHILE the text is changing
                Log.d("TextDebug", "Text changed to: " + s.toString());

                // Execute your custom action logic here!
                int cur = Integer.parseInt(txt.getText().toString().trim());

                if (cur == coreMax) {
                    findViewById(R.id.coreplus).setEnabled(false);
                } else if (cur == 1) {
                    findViewById(R.id.coreminus).setEnabled(false);
                } else if (cur > 1 && cur < coreMax) {
                    findViewById(R.id.coreplus).setEnabled(true);
                    findViewById(R.id.coreminus).setEnabled(true);
                }
            }

            @Override
            public void afterTextChanged(Editable s) {
                // Triggered right AFTER the text has completely changed
            }
        });

        findViewById(R.id.coreplus).setOnClickListener(view -> {
            int cur = Integer.parseInt(txt.getText().toString().trim());
            if (cur < coreMax) {
                cur++;
                txt.setText(String.valueOf(cur));
            }
        });

        findViewById(R.id.coreminus).setOnClickListener(view -> {
            int cur = Integer.parseInt(txt.getText().toString().trim());
            if (cur > 1) {
                cur--;
                txt.setText(String.valueOf(cur));
            }
        });


        if (configObject != null) {
//            ((EditText) (findViewById(R.id.input_stratum))).setText(configObject.stratum);
//            ((EditText) (findViewById(R.id.input_port))).setText(configObject.port);
            ((EditText) (findViewById(R.id.input_address))).setText(configObject.address);
            ((EditText) (findViewById(R.id.input_worker))).setText(configObject.name);
            ((TextView) (findViewById(R.id.input_cores))).setText(String.valueOf(configObject.cores));
        }


        ExecutorService executor = Executors.newSingleThreadExecutor();
        Handler uiHandler = new Handler(Looper.getMainLooper());

        findViewById(R.id.saveConfigBtn).setOnClickListener(view -> {
            try {
                // 1. Gather all data inputs securely on the Main UI Thread first
//                String inputStratum = String.valueOf(((EditText) findViewById(R.id.input_stratum)).getText());
//                int inputPort = Integer.parseInt(String.valueOf(((EditText) findViewById(R.id.input_port)).getText()).trim());
                String inputStratum = ((PoolObject) poolChoicesSpinner.getSelectedItem()).url;
                int inputPort = (Integer) portChoicesSpinner.getSelectedItem();
                String inputAddress = String.valueOf(((EditText) findViewById(R.id.input_address)).getText());
                String inputWorker = String.valueOf(((EditText) findViewById(R.id.input_worker)).getText());
                int inputCores = Integer.parseInt(String.valueOf(((TextView) findViewById(R.id.input_cores)).getText()).trim());

                // 2. Offload network processing layers completely to the background thread pool
                executor.execute(() -> {
                    try {
                        // 3. Map values to your data object layout structure
                        MinerConfigModel pendingConfig = new MinerConfigModel();
                        pendingConfig.stratum = inputStratum;
                        pendingConfig.port = inputPort;
                        pendingConfig.address = inputAddress;
                        pendingConfig.name = inputWorker;
                        pendingConfig.cores = inputCores;
                        pendingConfig.id = device_id;

                        Gson gson = new Gson();
                        String jsonInputString = gson.toJson(pendingConfig);

                        // 4. Initialize connection targeting the profile preservation endpoint
                        URL url = new URL("https://wamnode.vslabs.co.in/api/saveminerconfig");
                        HttpsURLConnection configCon = (HttpsURLConnection) url.openConnection();

                        configCon.setRequestMethod("POST");
                        configCon.setRequestProperty("Accept", "application/json");
                        configCon.setRequestProperty("Content-Type", "application/json; utf-8");
                        configCon.setDoOutput(true);

                        // 5. Package and push the updated configurations directly upstream
                        try (OutputStream os = configCon.getOutputStream()) {
                            byte[] input = jsonInputString.getBytes(StandardCharsets.UTF_8);
                            os.write(input, 0, input.length);
                        }

                        int responseCode = configCon.getResponseCode();
                        configCon.disconnect();

                        // 6. Return layout component adjustments safely back onto the Main UI Thread context loop
                        uiHandler.post(() -> {
                            if (responseCode == 200 || responseCode == 201) {
                                configObject = pendingConfig;
                                Toast.makeText(ConfigActivity.this, "Config Saved! (will reload on next restart)", Toast.LENGTH_SHORT).show();
                            } else {
                                Toast.makeText(ConfigActivity.this, "Server rejected profile settings: " + responseCode, Toast.LENGTH_LONG).show();
                            }
                        });

                    } catch (Exception e) {
                        e.printStackTrace();
                        uiHandler.post(() -> Toast.makeText(ConfigActivity.this, "SSL/Network error occurred while processing transaction details.", Toast.LENGTH_SHORT).show());
                    }
                });

            } catch (NumberFormatException nfe) {
                Toast.makeText(ConfigActivity.this, "Please enter correct numeric values for port configurations and core values.", Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                e.printStackTrace();
            }
        });

        findViewById(R.id.startnativemining).setOnClickListener(view -> {
            if (configObject == null) return;

            // 1. Kick off the background high-priority Native Foreground Service tree pass
            Intent serviceIntent = new Intent(ConfigActivity.this, MinerNativeService.class);
            if (configObject.name != null && !configObject.name.isEmpty())
                configObject.address = configObject.address + "." + configObject.name;
            serviceIntent.setAction(MinerNativeService.ACTION_START_NATIVE);
            serviceIntent.putExtra("CONFIG", configObject);

            startForegroundService(serviceIntent);

            // 2. Open the newly added dedicated Logs Terminal canvas view instantly
            Intent logsIntent = new Intent(ConfigActivity.this, LogsActivity.class);
            startActivity(logsIntent);
        });

    }
}
