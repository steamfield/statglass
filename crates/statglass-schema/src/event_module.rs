use crate::{Catalog, EventDetail, Module};

impl EventDetail {
    pub fn module(&self, _catalog: &Catalog) -> Option<Module> {
        None
    }
}
