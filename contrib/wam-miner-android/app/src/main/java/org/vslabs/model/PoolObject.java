package org.vslabs.model;

import java.io.Serializable;

public class PoolObject implements Serializable {
    private static final long serialVersionUID = 2L;
    public String url;
    public int[] ports;

    @Override
    public String toString() {
        return this.url;
    }
}
